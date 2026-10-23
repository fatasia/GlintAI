// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { EditorAssistant } from "./EditorAssistant";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseProject({ schemaVersion: 1, id: "assistant", title: "Project", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "One", narration: { text: "one", durationMs: 1000 } },
  { id: "two", kind: "title", title: "Two", narration: { text: "two", durationMs: 1000 } },
] });
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [];
  cleanup = () => act(() => root.unmount());
  const render = async (value = project, sceneId = "one") => { await act(async () => root.render(createElement(EditorAssistant, { project: value, sceneId, onChange: next => changes.push(next) }))); };
  await render();
  const input = async (text: string) => act(async () => {
    const element = div.querySelector<HTMLInputElement>('[aria-label="分镜修改指令"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async () => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "AI 修改本分镜")!.click());
  return { div, changes, render, input, send };
}
function deferred() { let resolve!: (response: Response) => void; return { promise: new Promise<Response>(yes => { resolve = yes; }), resolve: (response: Response) => resolve(response) }; }
const edited = () => { const value = structuredClone(project); (value.scenes[0] as { title: string }).title = "Edited"; (value.scenes[1] as { title: string }).title = "Unwanted"; value.title = "Unwanted global"; return value; };
describe("single workbench assistant", () => {
  it("pins a command to its captured target while selection changes and preserves unrelated content", async () => {
    const waiting = deferred(), fetcher = vi.fn().mockReturnValue(waiting.promise); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.input("改标题"); await h.send();
    expect(h.div.textContent).toContain("正在修改 one");
    await h.render(project, "two");
    expect(h.div.textContent).toContain("你 · one");
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).sceneId).toBe("one");
    expect(h.changes).toHaveLength(1); expect(h.changes[0]!.title).toBe("Project");
    expect(h.changes[0]!.scenes[0]).toMatchObject({ title: "Edited" });
    expect(h.changes[0]!.scenes[1]).toEqual(project.scenes[1]);
  });
  it("does not overwrite edits committed while the model was working", async () => {
    const waiting = deferred(); vi.stubGlobal("fetch", vi.fn().mockReturnValue(waiting.promise));
    const h = await mount(); await h.input("改标题"); await h.send();
    await h.render({ ...project, title: "Newer local edit" });
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    expect(h.changes).toHaveLength(0); expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("工程已变化");
  });
  it("cancels and suppresses a late result without resetting the conversation", async () => {
    const waiting = deferred(); vi.stubGlobal("fetch", vi.fn().mockReturnValue(waiting.promise));
    const h = await mount(); await h.input("改标题"); await h.send();
    await act(async () => [...h.div.querySelectorAll("button")].find(button => button.textContent === "取消修改")!.click());
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    expect(h.changes).toHaveLength(0); expect(h.div.textContent).toContain("已取消"); expect(h.div.textContent).toContain("改标题");
  });
  it("shows model configuration failure without applying work and locks targets", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 503 })); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.input("改标题"); await h.send();
    expect(h.changes).toHaveLength(0); expect(h.div.textContent).toContain("先配置文本模型");
    await h.render({ ...project, scenes: [{ ...project.scenes[0]!, locked: true }, project.scenes[1]!] });
    expect(h.div.querySelector<HTMLInputElement>('[aria-label="分镜修改指令"]')!.disabled).toBe(true);
  });
  it("expires even if a broken transport ignores cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const h = await mount(); vi.useFakeTimers(); await h.input("改标题"); await h.send();
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("超时");
    expect([...h.div.querySelectorAll("button")].some(button => button.textContent === "取消修改")).toBe(false);
  });
});
