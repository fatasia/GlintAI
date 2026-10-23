// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildTimeline } from "@glintai/scenescript";
import { IdeaStudio } from "./IdeaStudio";
import { parseEditorProject } from "./editor-model";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function mount() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  dispose = () => {
    act(() => root.unmount());
    div.remove();
  };
  await act(async () => {
    root.render(createElement(IdeaStudio, { cardStyle: {} }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return div;
}
it("restores a lost POST receipt using requestId, without replaying paid work", async () => {
  localStorage.setItem("glint.last-job:request", "request-1234");
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => _url === "/api/media/library" ? Response.json({ assets: [] }) : _url === "/api/health" ? Response.json({ voices: ["mock", "edge"] }) : new Response(
        JSON.stringify({
          id: "idea-recovered",
          status: "done",
          stage: "done",
          log: [],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await mount();
  expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/make"))[0]![0]).toBe("/api/make/request/request-1234");
  // QuickVideo probes the text-model capability on mount; it is not part of job recovery.
  expect(fetch.mock.calls.filter(([url]) => url !== "/api/settings/llm")).toHaveLength(3);
  expect(localStorage.getItem("glint.last-job")).toBe("idea-recovered");
  expect(localStorage.getItem("glint.last-job:request")).toBeNull();
});
it("pauses a failed lookup and retries GET only when requested", async () => {
  localStorage.setItem("glint.last-job:request", "request-1234");
  let queries = 0;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices: ["mock", "edge"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/settings/llm") return Response.json({ configured: false });
    if (++queries === 1) return new Response("{}", { status: 404 });
    return Response.json({ id: "idea-recovered", status: "done", log: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  expect(div.textContent).toContain("回执未确认");
  const button = [...div.querySelectorAll("button")].find(
    (x) => x.textContent === "恢复查询",
  )!;
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(fetch.mock.calls.filter(([url]) => url === "/api/make/request/request-1234")).toHaveLength(2);
  expect(fetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
});
const editedProject = { schemaVersion: 1, id: "editor-test", title: "编辑测试", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "One", narration: { text: "第一句" } },
  { id: "two", kind: "definition", term: "Two", definition: "第二句", narration: { text: "第二句" } },
] };
it("restores the autosaved editor and submits the edited project, not the original source", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => url === "/api/make" ? new Response(JSON.stringify({ jobId: "idea-edit-test" })) : new Response(JSON.stringify({ id: "idea-edit-test", status: "done", log: [] })));
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  expect(div.textContent).toContain("2 个分镜");
  const submit = [...div.querySelectorAll("button")].find(button => button.textContent === "生成草稿")!;
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make")!;
  const payload = JSON.parse(call[1]!.body as string);
  expect(payload.project.id).toBe("editor-test");
  expect(payload.source).toBeUndefined(); expect(payload.tts).toBe("mock");
});
it("undoes and redoes scene deletion", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject }));
  const div = await mount();
  const click = async (label: string) => { await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === label)!.click(); }); };
  await click("删除分镜"); expect(div.textContent).toContain("1 个分镜");
  await click("撤销"); expect(div.textContent).toContain("2 个分镜");
  await click("重做"); expect(div.textContent).toContain("1 个分镜");
});
it("creates from the unified library, backs up the old project and opens editable content", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  const card = [...div.querySelectorAll("button")].find(button => button.querySelector("strong")?.textContent === "12 秒产品发布")!;
  await act(async () => card.click());
  await act(async () => div.querySelector<HTMLInputElement>('[aria-label="创作库"] input[type="checkbox"]')!.click());
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "用这个创作")!.click());
  expect(div.textContent).toContain("3 个分镜");
  expect(div.querySelector('[aria-label="共享工程编辑"]')).not.toBeNull();
  const saved = JSON.parse(localStorage.getItem("glint.projects") ?? "[]");
  expect(saved[0].project.id).toBe("editor-test");
  expect(div.textContent).toContain("product-launch v1.0.0");
});
it("does not load the player before an explicit preview action", async () => {
  const div = await mount();
  expect(div.querySelector("video")).toBeNull();
  expect(div.textContent).toContain("载入入门示例");
});

it("puts examples and recent works on the first screen and keeps jargon out of the main path", async () => {
  localStorage.setItem("glint.projects", JSON.stringify([{ id: "p1", name: "上周的讲解", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now() }]));
  const div = await mount();
  const recent = div.querySelector('[aria-label="最近作品"]')!;
  expect(recent).not.toBeNull();
  expect(recent.closest("details")).toBeNull();
  expect(div.textContent).toContain("上周的讲解");
  const example = [...div.querySelectorAll("button")].find(button => button.textContent === "一分钟讲清熵")!;
  await act(async () => { example.click(); });
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!.value).toContain("熵");
  expect(div.textContent).not.toContain("叙事模板");
  expect(div.textContent).not.toContain("编排分镜");
  expect(div.textContent).toContain("参考片 → 可审阅工程");
});

it("labels all ten renderable styles", async () => {
  const div = await mount();
  const select = div.querySelector<HTMLSelectElement>('select[aria-label="风格"]')!;
  expect(select.options).toHaveLength(10);
  expect([...select.options].every(option => (option.textContent ?? "").trim().length > 0)).toBe(true);
  expect(select.options[5]!.textContent).toBe("手绘笔记");
});

function stubApi(voices: string[]) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/make") return Response.json({ jobId: "idea-preflight-test" });
    if (url.startsWith("/api/make/")) return Response.json({ id: "idea-preflight-test", status: "done", log: [] });
    if (url.startsWith("/api/session/")) return Response.json({});
    return Response.json({ id: "idea-preflight-test", status: "done", log: [] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function mountSavedProject() {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  return mount();
}

async function choose(div: HTMLElement, label: string, value: string) {
  const select = div.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return select;
}

it("submits the free silent path without any cost confirmation", async () => {
  const fetch = stubApi(["mock", "openai"]);
  const div = await mountSavedProject();
  expect(div.querySelector('[aria-label="出片前预检"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="我确认可能产生费用"]')).toBeNull();
  const submit = [...div.querySelectorAll("button")].find(button => button.textContent === "生成草稿")!;
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make");
  expect(call).toBeTruthy();
  const payload = JSON.parse(call![1]!.body as string);
  expect(payload.tts).toBe("mock");
  expect(payload).not.toHaveProperty("costConfirmed");
});

it("blocks a possibly billable cloud engine until the cost confirmation is checked", async () => {
  const fetch = stubApi(["mock", "openai"]);
  const div = await mountSavedProject();
  await choose(div, "配音", "openai");
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.textContent).toContain("可能计费");
  expect(summary.textContent).toContain("本机未配置价格表，费用由服务商决定");
  const checkbox = div.querySelector<HTMLInputElement>('[aria-label="我确认可能产生费用"]')!;
  expect(checkbox.checked).toBe(false);
  const submit = [...div.querySelectorAll("button")].find(button => button.textContent === "生成草稿")!;
  expect(submit.disabled).toBe(true);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fetch.mock.calls.some(([url]) => url === "/api/make")).toBe(false);
  await act(async () => { checkbox.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox.checked).toBe(true);
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make")!;
  const payload = JSON.parse(call[1]!.body as string);
  expect(payload.tts).toBe("openai");
  expect(Object.keys(payload).sort()).toEqual(["aspect", "encoding", "music", "project", "requestId", "template", "theme", "tts"]);
});

it("resets the cost confirmation when engine, encoding or project changes", async () => {
  stubApi(["mock", "openai", "elevenlabs"]);
  const div = await mountSavedProject();
  const checkbox = () => div.querySelector<HTMLInputElement>('[aria-label="我确认可能产生费用"]')!;
  await choose(div, "配音", "openai");
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await choose(div, "导出规格", "quality");
  expect(checkbox().checked).toBe(false);
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await choose(div, "配音", "elevenlabs");
  expect(checkbox().checked).toBe(false);
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await act(async () => {
    [...div.querySelectorAll("button")].find(button => button.textContent === "添加图表（示例数据）")!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(checkbox().checked).toBe(false);
  expect(div.querySelector('[aria-label="分镜数"]')!.textContent).toBe("3 个");
});

it("shows scene count and the buildTimeline duration before rendering", async () => {
  stubApi(["mock"]);
  const div = await mountSavedProject();
  const project = parseEditorProject(editedProject);
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.querySelector('[aria-label="分镜数"]')!.textContent).toBe("2 个");
  expect(summary.querySelector('[aria-label="预计总时长"]')!.textContent).toBe(`${(buildTimeline(project).totalMs / 1000).toFixed(1)} 秒`);
  expect(summary.querySelector('[aria-label="配音引擎"]')!.textContent).toBe("无声草稿 · 最快");
  expect(summary.querySelector('[aria-label="导出规格"]')!.textContent).toBe("预览 · 半尺寸 / 快速");
  await choose(div, "导出规格", "quality");
  expect(summary.querySelector('[aria-label="导出规格"]')!.textContent).toBe("母版 · 全尺寸 / CRF16");
});
