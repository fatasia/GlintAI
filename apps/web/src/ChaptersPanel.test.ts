// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseEditorProject } from "./editor-model";
import { ChaptersPanel } from "./ChaptersPanel";
import { captureChapter, chaptersDocument, CHAPTERS_KEY, readChapters, writeChapters, type ChapterContext } from "./ChaptersStore";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
beforeEach(() => { vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } }); });
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const context: ChapterContext = { mode: "source", text: "资料", template: "explainer", theme: "glint-dark", evidence: "依据" };
const project = (id = "one") => parseEditorProject({ schemaVersion: 1, id, title: `章节 ${id}`, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "s", kind: "title", title: "镜头", narration: { text: "内容", durationMs: 3000 } }] });
async function mount(props: Partial<Parameters<typeof ChaptersPanel>[0]> = {}) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const base = { project: project(), context, onOpen: vi.fn(() => true), ...props };
  dispose = () => act(() => root.unmount());
  const render = async (next: Partial<typeof base> = {}) => { Object.assign(base, next); await act(async () => root.render(createElement(ChaptersPanel, base))); };
  await render(); return { node, render, onOpen: base.onOpen };
}
function button(node: ParentNode, label: string) { const found = [...node.querySelectorAll("button")].find(item => item.textContent === label); if (!found) throw new Error(`missing button ${label}`); return found; }
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function consent(node: ParentNode) { await click(node.querySelector<HTMLInputElement>('[aria-label="确认章节操作"] input[type="checkbox"]')!); }
async function file(node: ParentNode, content: string) {
  const input = node.querySelector<HTMLInputElement>('[aria-label="章节 JSON 文件"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [{ size: content.length, text: async () => content }] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
}
it("adds only on explicit action, updates snapshots with separate consent and shows unsaved edits", async () => {
  const { node, render } = await mount(); expect(readChapters()).toEqual([]);
  await click(button(node, "将当前工程加入章节")); expect(readChapters()).toHaveLength(1); expect(node.textContent).toContain("3.0 秒");
  await render({ project: { ...project(), title: "编辑新内容" } }); expect(readChapters()[0]!.project.title).toBe("章节 one"); expect(node.textContent).toContain("编辑区有新修改");
  await click(button(node, "更新当前章节快照")); expect(button(node, "确认更新快照").disabled).toBe(true);
  await consent(node); await click(button(node, "确认更新快照")); expect(readChapters()[0]!.project.title).toBe("编辑新内容"); expect(readChapters()[0]!.title).toBe("章节 one");
});
it("requires confirmation to load or remove, and invalidates consent when editor content or task changes", async () => {
  writeChapters([captureChapter(project("two"), context)]); const { node, onOpen, render } = await mount();
  await click(button(node, "载入编辑")); expect(onOpen).not.toHaveBeenCalled(); expect(button(node, "确认载入").disabled).toBe(true);
  await consent(node); await render({ project: { ...project(), title: "new" } }); expect(node.querySelector('[aria-label="确认章节操作"]')).toBeNull();
  await click(button(node, "载入编辑")); await consent(node); await click(button(node, "确认载入")); expect(onOpen).toHaveBeenCalledWith(readChapters()[0]);
  await click(button(node, "移除")); await consent(node); await render({ disabled: true }); expect(node.querySelector('[aria-label="确认章节操作"]')).toBeNull();
  expect(button(node, "载入编辑").disabled).toBe(true); expect(readChapters()).toHaveLength(1);
  await render({ disabled: false }); await click(button(node, "移除")); await consent(node); await click(button(node, "确认移除")); expect(readChapters()).toEqual([]);
});
it("renames without changing project title and protects order boundaries", async () => {
  writeChapters([captureChapter(project(), context), captureChapter(project("two"), context)]); const { node } = await mount();
  expect(node.querySelector<HTMLButtonElement>('[aria-label="上移 章节 one"]')!.disabled).toBe(true);
  await click(node.querySelector<HTMLButtonElement>('[aria-label="下移 章节 one"]')!); expect(readChapters().map(item => item.project.id)).toEqual(["two", "one"]);
  await click(button(node, "重命名")); const input = node.querySelector<HTMLInputElement>('[aria-label="章节新名称"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "第二章 · 夜雨"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(readChapters()[0]!.title).toBe("第二章 · 夜雨"); expect(readChapters()[0]!.project.title).toBe("章节 two");
});
it("imports only after validated preview and consent, rejects collisions without replacing editor", async () => {
  const { node, onOpen } = await mount(); const incoming = chaptersDocument([captureChapter(project("two"), context)]);
  await file(node, JSON.stringify(incoming)); expect(readChapters()).toEqual([]); expect(node.textContent).toContain("添加 1 个章节？");
  await consent(node); await click(button(node, "确认添加章节")); expect(readChapters()[0]!.project.id).toBe("two"); expect(onOpen).not.toHaveBeenCalled();
  await file(node, JSON.stringify(incoming)); expect(node.querySelector('[role="alert"]')!.textContent).toContain("重复"); expect(readChapters()).toHaveLength(1);
  await file(node, JSON.stringify({ ...incoming, chapters: [{ ...incoming.chapters[0], project: { nope: true } }] })); expect(readChapters()).toHaveLength(1); expect(onOpen).not.toHaveBeenCalled();
});
it("preserves UI and saved state on quota failures and refuses to overwrite corrupted local data", async () => {
  const chapter = captureChapter(project("two"), context); writeChapters([chapter]); const before = localStorage.getItem(CHAPTERS_KEY), { node } = await mount();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await click(button(node, "将当前工程加入章节")); expect(node.querySelectorAll('[aria-label="章节列表"] > li')).toHaveLength(1); expect(localStorage.getItem(CHAPTERS_KEY)).toBe(before); expect(node.textContent).toContain("未保存本次修改");
});
it("does not discard unreadable local data and surfaces a failed current-project backup", async () => {
  localStorage.setItem(CHAPTERS_KEY, "broken"); const first = await mount(); expect(button(first.node, "将当前工程加入章节").disabled).toBe(true); expect(localStorage.getItem(CHAPTERS_KEY)).toBe("broken"); dispose(); first.node.remove();
  writeChapters([captureChapter(project("two"), context)]); const second = await mount({ onOpen: () => { throw new Error("当前工程备份失败"); } });
  await click(button(second.node, "载入编辑")); await consent(second.node); await click(button(second.node, "确认载入")); expect(second.node.textContent).toContain("当前工程备份失败"); expect(second.node.querySelector('[aria-label="确认章节操作"]')).not.toBeNull();
});
it("fails closed when Web Locks is unavailable", async () => {
  vi.stubGlobal("navigator", {});
  const { node } = await mount();
  await click(button(node, "将当前工程加入章节"));
  expect(localStorage.getItem(CHAPTERS_KEY)).toBeNull();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("不支持安全的跨标签章节锁");
});

it("refuses writes while another tab holds the chapter lock", async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: { ifAvailable: boolean }, callback: (lock: null) => unknown) => {
    expect(options.ifAvailable).toBe(true);
    return callback(null);
  } } });
  const { node } = await mount();
  await click(button(node, "将当前工程加入章节"));
  expect(localStorage.getItem(CHAPTERS_KEY)).toBeNull();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("其他标签页正在修改章节");
});

it("detects another window's write instead of losing it", async () => {
  const { node } = await mount(); writeChapters([captureChapter(project("two"), context)]);
  await click(button(node, "将当前工程加入章节")); expect(readChapters().map(chapter => chapter.project.id)).toEqual(["two"]); expect(node.textContent).toContain("其他窗口更新");
});
