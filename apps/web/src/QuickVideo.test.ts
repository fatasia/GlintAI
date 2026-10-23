// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickVideo } from "./QuickVideo";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const job = (status: string, extra: Record<string, unknown> = {}) => ({ id: "idea-abc123", status, log: [], ...extra });
const intent = "给咖啡店做一条15秒开业宣传，竖屏";
const material = "# 开业资料\n\n- 咖啡店 10 月 1 日开业\n- 15 秒竖屏宣传，主打手冲咖啡和早餐\n\n欢迎附近居民来喝第一杯。";
const INTENT_NOTICE = "一句话成片需要配置文本模型；可以先粘贴资料，或到设置里配置模型";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function posts(fetcher: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetcher.mock.calls
    .filter(([url, init]) => String(url) === "/api/make" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}
async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}
async function mount(extra: Record<string, unknown> = {}) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(QuickVideo, { pollMs: 0, ...extra })));
  await flush();
  const type = async (value: string) => act(async () => {
    const area = div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = async (text: string) => act(async () => {
    const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text));
    if (!target) throw new Error(`button not found: ${text}`);
    target.click();
  });
  const mode = () => div.querySelector('[aria-label="当前输入模式"]')?.textContent ?? "";
  const value = () => div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')?.value ?? "";
  return { div, type, click, mode, value };
}
function happyServer(configured: boolean, overrides: (url: string, init: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  return stubFetch((url, init) => {
    const override = overrides(url, init);
    if (override) return override;
    if (url === "/api/settings/llm") return Response.json({ configured });
    if (url === "/api/make" && init.method === "POST") return Response.json({ jobId: "idea-abc123" });
    if (url === "/api/make/idea-abc123") return Response.json(job("done", { video: "/api/video/idea-abc123" }));
    return Response.json({ checks: [], ok: true });
  });
}
describe("job recovery", () => {
  it("reattaches to a job that was running when the window closed", async () => {
    const fetcher = stubFetch((url, init) => {
      if (url === "/api/settings/llm") return Response.json({ configured: false });
      if (url === "/api/make/idea-abc123") return Response.json(job("done", { video: "/api/video/idea-abc123" }));
      return Response.json({ checks: [], ok: true });
    });
    localStorage.setItem("glint.quick-video.job", "idea-abc123");
    const h = await mount();
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/make/idea-abc123")).toBe(true);
    expect(h.div.querySelector('video[aria-label="快速成片结果"]')?.getAttribute("src")).toBe("/api/video/idea-abc123");
  });
  it("drops a stale job id instead of showing a broken result", async () => {
    stubFetch((url, init) => {
      if (url === "/api/settings/llm") return Response.json({ configured: false });
      if (url === "/api/make/idea-abc123") return new Response(JSON.stringify({ error: "Unknown job" }), { status: 404 });
      return Response.json({ checks: [], ok: true });
    });
    localStorage.setItem("glint.quick-video.job", "idea-abc123");
    const h = await mount();
    expect(h.div.querySelector('video[aria-label="快速成片结果"]')).toBeNull();
    expect(localStorage.getItem("glint.quick-video.job")).toBeNull();
  });
});describe("one-box quick video", () => {
  it("loads the composed project after finishing so the workbench can keep editing", async () => {
    const edited: unknown[] = [];
    const fetcher = stubFetch((url, init) => {
      if (url === "/api/settings/llm") return Response.json({ configured: false });
      if (url === "/api/make" && init.method === "POST") return Response.json({ jobId: "idea-abc123" });
      if (url === "/api/make/idea-abc123") return Response.json(job("done", { video: "/api/video/idea-abc123" }));
      if (url === "/api/make/idea-abc123/project") return Response.json({ project: { id: "idea-abc123", scenes: [{ id: "one" }] } });
      return Response.json({ checks: [], ok: true });
    });
    const h = await mount({ onEditProject: (value: unknown) => edited.push(value) });
    await h.type(material); await h.click("生成草稿（免费）"); await flush();
    await h.click("继续编辑这支视频"); await flush();
    expect(edited).toEqual([{ id: "idea-abc123", scenes: [{ id: "one" }] }]);
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/make/idea-abc123/project")).toBe(true);
  });
  it("explains missing composed project without losing the downloadable video", async () => {
    const edited: unknown[] = [];
    stubFetch((url, init) => {
      if (url === "/api/settings/llm") return Response.json({ configured: false });
      if (url === "/api/make" && init.method === "POST") return Response.json({ jobId: "idea-abc123" });
      if (url === "/api/make/idea-abc123") return Response.json(job("done", { video: "/api/video/idea-abc123" }));
      if (url === "/api/make/idea-abc123/project") return new Response(JSON.stringify({ error: "gone" }), { status: 404 });
      return Response.json({ checks: [], ok: true });
    });
    const h = await mount({ onEditProject: (value: unknown) => edited.push(value) });
    await h.type(material); await h.click("生成草稿（免费）"); await flush();
    await h.click("继续编辑这支视频"); await flush();
    expect(edited).toEqual([]);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("无法载入这支视频的工程");
    expect(h.div.querySelector('[aria-label="快速成片结果"]')).not.toBeNull();
  });
  it("submits pasted material as source even when a text model is configured", async () => {
    const fetcher = happyServer(true);
    const h = await mount();
    await h.type(material);
    expect(h.mode()).toContain("一段资料");
    await h.click("生成草稿（免费）");
    await flush();
    const sent = posts(fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: material, tts: "mock", music: "off", encoding: "draft", aspect: "16:9" });
    expect(sent[0]).not.toHaveProperty("idea");
    expect(await h.div.textContent).toContain("已完成");
    expect(h.div.querySelector('video[aria-label="快速成片结果"]')?.getAttribute("src")).toBe("/api/video/idea-abc123");
  });
  it("recovers a lost make receipt instead of submitting the same paid task twice", async () => {
    const ids: string[] = [];
    let posts = 0;
    stubFetch((url, init) => {
      if (url === "/api/settings/llm") return Response.json({ configured: false });
      if (url === "/api/make" && init.method === "POST") {
        posts++; ids.push(JSON.parse(String(init.body)).requestId);
        return Promise.reject(new Error("network"));
      }
      if (url.startsWith("/api/make/request/")) return Response.json({ jobId: "idea-recovered" });
      if (url === "/api/make/idea-recovered") return Response.json({ ...job("done"), id: "idea-recovered" });
      return Response.json({});
    });
    const h = await mount();
    await h.type(material);
    await h.click("生成草稿（免费）");
    await flush(); await flush();
    expect(posts).toBe(1);
    expect(ids[0]!).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.div.querySelector('video[aria-label="快速成片结果"]')?.getAttribute("src")).toBe("/api/video/idea-recovered");
  });
  it("applies a recipe preset to the composer and the submitted job", async () => {
  const fetcher = happyServer(false);
  const h = await mount({ preset: { label: "产品发布 · 深色科技", text: material, aspect: "9:16", template: "listicle", theme: "glint-dark", nonce: 1 } });
  expect(h.value()).toBe(material);
  expect(h.mode()).toContain("一段资料");
  await h.click("生成草稿（免费）");
  await flush();
  const sent = posts(fetcher);
  expect(sent[0]).toMatchObject({ source: material, aspect: "9:16", template: "listicle", theme: "glint-dark" });
});
it("submits a short intent as an idea only when the capability probe reports a model", async () => {
    const fetcher = happyServer(true);
    const h = await mount();
    await h.type(intent);
    expect(h.mode()).toContain("一句想法");
    await h.click("生成草稿（免费）");
    await flush();
    const sent = posts(fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ idea: intent, aspect: "16:9", tts: "mock", music: "off", encoding: "draft" });
    expect(sent[0]).not.toHaveProperty("source");
    const probe = fetcher.mock.calls.find(([url]) => String(url) === "/api/settings/llm");
    expect(probe).toBeDefined();
    expect((probe![1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
  it.each([
    ["unconfigured", () => Response.json({ configured: false })],
    ["missing endpoint", () => new Response("not found", { status: 404 })],
  ])("blocks a short intent when the capability is %s, then switches to material with the same text", async (_label, probe) => {
    const fetcher = happyServer(false, url => url === "/api/settings/llm" ? probe() : undefined);
    const h = await mount();
    await h.type(intent);
    expect(h.mode()).toContain("一句想法");
    expect(h.div.textContent).toContain(INTENT_NOTICE);
    await h.click("生成草稿（免费）");
    expect(posts(fetcher)).toHaveLength(0);
    await h.click("改用资料模式");
    expect(h.mode()).toContain("一段资料");
    expect(h.value()).toBe(intent);
    expect(h.div.textContent).not.toContain(INTENT_NOTICE);
    expect(posts(fetcher)).toHaveLength(0);
  });
  it("keeps material mode after the explicit switch while the text still looks like an idea", async () => {
    const fetcher = happyServer(false);
    const h = await mount();
    await h.type(intent);
    await h.click("改用资料模式");
    const expanded = `${intent}，预算低`;
    await h.type(expanded);
    expect(h.mode()).toContain("一段资料");
    await h.click("生成草稿（免费）");
    await flush();
    const sent = posts(fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: expanded });
  });
  it("keeps typing and material generation working when the capability probe fails", async () => {
    const fetcher = happyServer(false, url => url === "/api/settings/llm" ? Promise.reject(new TypeError("Failed to fetch")) : undefined);
    const h = await mount();
    await h.type(intent);
    expect(h.mode()).toContain("一句想法");
    expect(h.div.textContent).toContain(INTENT_NOTICE);
    await h.type(material);
    expect(h.mode()).toContain("一段资料");
    await h.click("生成草稿（免费）");
    await flush();
    const sent = posts(fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: material });
    expect(h.div.textContent).not.toContain(INTENT_NOTICE);
  });
  it("aborts the capability probe when the box unmounts", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetcher);
    const div = document.createElement("div"); document.body.appendChild(div);
    const root = createRoot(div);
    await act(async () => root.render(createElement(QuickVideo, { pollMs: 0 })));
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal!.aborted).toBe(true);
    cleanup = () => {};
  });
  it("treats a capability probe that never answers as unavailable after the timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const div = document.createElement("div"); document.body.appendChild(div);
    const root = createRoot(div); cleanup = () => act(() => root.unmount());
    await act(async () => root.render(createElement(QuickVideo, { pollMs: 0 })));
    const area = div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, intent);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(div.textContent).toContain("确认中");
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(div.querySelector('[aria-label="当前输入模式"]')?.textContent).toContain("一句想法");
    expect(div.textContent).toContain(INTENT_NOTICE);
    expect(div.textContent).not.toContain("确认中");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("updates the aria-live mode label at the detection boundaries", async () => {
    happyServer(false);
    const h = await mount();
    await h.type("想".repeat(79));
    expect(h.mode()).toContain("一句想法");
    await h.type("长".repeat(80));
    expect(h.mode()).toContain("一段资料");
    await h.type("# 标题");
    expect(h.mode()).toContain("一段资料");
    await h.type("- 要点");
    expect(h.mode()).toContain("一段资料");
    await h.type("第一行\n第二行");
    expect(h.mode()).toContain("一句想法");
    await h.type("第一行\n\n第二行");
    expect(h.mode()).toContain("一段资料");
    await h.type("这是一个很短的想法");
    expect(h.mode()).toContain("一句想法");
  });
  it("still refuses thin material without posting and explains the 20-character floor", async () => {
    const fetcher = happyServer(true);
    const h = await mount();
    await h.type("# 标题\n\n- 要点");
    expect(h.mode()).toContain("一段资料");
    await h.click("生成草稿（免费）");
    expect(posts(fetcher)).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("至少写 20 个字");
  });
  it("surfaces server refusal and failed jobs with actionable text", async () => {
    let submitted = 0;
    const fetcher = happyServer(true, (url, init) => {
      if (url === "/api/make" && init.method === "POST" && submitted++ === 0) return new Response(JSON.stringify({ error: "Too many jobs; try again later." }), { status: 429 });
      if (url === "/api/make/idea-abc123") return Response.json(job("failed", { error: "Invalid editor project" }));
      return undefined;
    });
    const h = await mount();
    await h.type(material);
    await h.click("生成草稿（免费）");
    await flush();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("Too many jobs");
    await h.click("生成草稿（免费）");
    await flush();
    expect(posts(fetcher)).toHaveLength(2);
    expect(await h.div.textContent).toContain("Invalid editor project");
  });
});
