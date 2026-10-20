// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { IdeaStudio } from "./IdeaStudio";
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
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(localStorage.getItem("glint.last-job")).toBe("idea-recovered");
  expect(localStorage.getItem("glint.last-job:request")).toBeNull();
});
it("pauses a failed lookup and retries GET only when requested", async () => {
  localStorage.setItem("glint.last-job:request", "request-1234");
  let queries = 0;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices: ["mock", "edge"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
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
  expect(fetch).toHaveBeenCalledTimes(4);
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
it("does not load the player before an explicit preview action", async () => {
  const div = await mount();
  expect(div.querySelector("video")).toBeNull();
  expect(div.textContent).toContain("载入入门示例");
});
