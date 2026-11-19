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
    const element = div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async () => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "AI 修改本分镜")!.click());
  return { div, changes, render, input, send };
}
function deferred() { let resolve!: (response: Response) => void; return { promise: new Promise<Response>(yes => { resolve = yes; }), resolve: (response: Response) => resolve(response) }; }
const edited = () => { const value = structuredClone(project); (value.scenes[0] as { title: string }).title = "Edited"; (value.scenes[1] as { title: string }).title = "Unwanted"; value.title = "Unwanted global"; return value; };
describe("single workbench assistant", () => {
  it("pins a command to its captured target while selection changes and preserves unrelated content", async () => {
    const waiting = deferred(), fetcher = vi.fn().mockReturnValue(waiting.promise); vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [] }));
      return fetcher(target, init);
    });
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
    const waiting = deferred(); vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [] }));
      return waiting.promise;
    });
    const h = await mount(); await h.input("改标题"); await h.send();
    await h.render({ ...project, title: "Newer local edit" });
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    expect(h.changes).toHaveLength(0); expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("工程已变化");
  });
  it("replans the original instruction against the latest project and original target", async () => {
    const waiting = deferred(), calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const target = String(url), body = JSON.parse(String(init?.body));
      calls.push({ url: target, body });
      if (target.endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [] }));
      if (calls.filter(call => call.url.endsWith("/api/edit-scene")).length === 1) return waiting.promise;
      const result = structuredClone(body.project); result.scenes[0].title = "Replanned";
      return Promise.resolve(Response.json({ project: result }));
    }));
    const h = await mount(); await h.input("改标题"); await h.send();
    const newer = { ...project, title: "Newer local edit" };
    await h.render(newer, "two");
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    await h.input("保留这份草稿");
    await act(async () => [...h.div.querySelectorAll("button")].find(button => button.textContent === "基于最新工程重新规划")!.click());
    const plans = calls.filter(call => call.url.endsWith("/api/assistant/plan"));
    const edits = calls.filter(call => call.url.endsWith("/api/edit-scene"));
    expect(plans).toHaveLength(2); expect(plans[1]!.body.project.title).toBe("Newer local edit");
    expect(edits[1]!.body).toMatchObject({ sceneId: "one", instruction: "改标题", project: { title: "Newer local edit" } });
    expect(h.changes).toHaveLength(1); expect(h.changes[0]!.scenes[0]).toMatchObject({ title: "Replanned" });
    expect(h.div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!.value).toBe("保留这份草稿");
  });
  it("does not replan when the original project or target is unavailable or locked", async () => {
    const waiting = deferred(), fetcher = vi.fn((url: string | URL | Request) => String(url).endsWith("/api/assistant/plan") ? Promise.resolve(Response.json({ steps: [] })) : waiting.promise);
    vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.input("改标题"); await h.send();
    await h.render({ ...project, title: "Changed" });
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    const button = () => [...h.div.querySelectorAll("button")].find(item => item.textContent === "基于最新工程重新规划")!;
    await h.render({ ...project, id: "other" }); expect(button().disabled).toBe(true);
    await h.render({ ...project, scenes: [project.scenes[1]!] }); expect(button().disabled).toBe(true);
    await h.render({ ...project, scenes: [{ ...project.scenes[0]!, locked: true }, project.scenes[1]!] }); expect(button().disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels and suppresses a late result without resetting the conversation", async () => {
    const waiting = deferred(); vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [] }));
      return waiting.promise;
    });
    const h = await mount(); await h.input("改标题"); await h.send();
    await act(async () => [...h.div.querySelectorAll("button")].find(button => button.textContent === "取消修改")!.click());
    await act(async () => waiting.resolve(Response.json({ project: edited() })));
    expect(h.changes).toHaveLength(0); expect(h.div.textContent).toContain("已取消"); expect(h.div.textContent).toContain("改标题");
  });
  it("shows model configuration failure without applying work and locks targets", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 503 })); vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [] }));
      return fetcher(target, init);
    });
    const h = await mount(); await h.input("改标题"); await h.send();
    expect(h.changes).toHaveLength(0); expect(h.div.textContent).toContain("先配置文本模型");
    await h.render({ ...project, scenes: [{ ...project.scenes[0]!, locked: true }, project.scenes[1]!] });
    expect(h.div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!.disabled).toBe(true);
  });
  it("expires even if a broken transport ignores cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const h = await mount(); vi.useFakeTimers(); await h.input("改标题"); await h.send();
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("超时");
    expect([...h.div.querySelectorAll("button")].some(button => button.textContent === "取消修改")).toBe(false);
  });
  it("offers scene references after typing @ and inserts the picked one", async () => {
    const h = await mount();
    await h.input("参考");
    await h.input("参考@");
    const listbox = h.div.querySelector('[role="listbox"][aria-label="引用镜头建议"]')!;
    expect(listbox).toBeTruthy();
    expect(listbox.textContent).toContain("@镜头2 · two");
    await act(async () => ([...listbox.querySelectorAll('button[role="option"]')].find(option => option.textContent?.includes("two")) as HTMLButtonElement).click());
    expect(h.div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!.value).toBe("参考@镜头2 ");
    expect(h.div.querySelector('[role="listbox"]')).toBeNull();
  });
  it("closes the reference list with Escape and keyboard-selects with arrows", async () => {
    const h = await mount();
    await h.input("@");
    const inputElement = h.div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!;
    await act(async () => inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(inputElement.value).toBe("@镜头2 ");
    await h.input("@");
    await act(async () => inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(h.div.querySelector('[role="listbox"]')).toBeNull();
  });
});

it("multi-step: plans across scenes, executes sequentially and logs each step", async () => {
  const calls: Array<{ url: string; body: { sceneId?: string; instruction?: string } }> = [];
  const stepReply = (sceneTitle: string) => Response.json({ project: (() => { const p = structuredClone(project); (p.scenes[0] as { title: string }).title = sceneTitle; return p; })() });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: target, body });
    if (target.endsWith("/api/assistant/plan")) return Response.json({ steps: [
      { sceneId: "one", action: "把标题改短" },
      { sceneId: "two", action: "把叙述接上" },
    ] });
    // Each edit-scene call reports its own scene edited.
    const sid = body.sceneId;
    const p = structuredClone(project);
    const scene = p.scenes.find(s => s.id === sid);
    if (scene && scene.kind === "title") scene.title = `改:${sid}`;
    return Response.json({ project: p });
  }));
  const h = await mount();
  await h.input("把两个镜头都改得更好");
  await h.send();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const editCalls = calls.filter(call => call.url.endsWith("/api/edit-scene"));
  expect(editCalls.map(call => call.body.sceneId)).toEqual(["one", "two"]);
  // Multi-step folds both edits into ONE onChange at the end (single undo step).
  expect(h.changes).toHaveLength(1);
  const finalScene = h.changes[0]!.scenes.find(scene => scene.id === "two");
  expect(finalScene && finalScene.kind === "title" ? finalScene.title : "").toBe("改:two");
  // The log lists both steps.
  expect(h.div.textContent).toContain("执行了 2 步");
  expect(h.div.textContent).toContain("[one] 把标题改短");
});

it("does not apply a late final multi-step response after cancellation", async () => {
  const waiting = deferred(); let edits = 0;
  vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
    if (String(url).endsWith("/api/assistant/plan")) return Promise.resolve(Response.json({ steps: [{ sceneId: "one", action: "一" }, { sceneId: "two", action: "二" }] }));
    edits++;
    return edits === 1 ? Promise.resolve(Response.json({ project })) : waiting.promise;
  }));
  const h = await mount(); await h.input("修改两镜"); await h.send();
  expect(edits).toBe(2);
  await act(async () => [...h.div.querySelectorAll("button")].find(button => button.textContent === "取消修改")!.click());
  await act(async () => waiting.resolve(Response.json({ project: edited() })));
  expect(h.changes).toHaveLength(0);
});
