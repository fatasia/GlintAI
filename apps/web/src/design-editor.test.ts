// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import type { DesignEditHandle } from "./artifact-project";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesignEditor, type DesignEditorProps } from "./DesignEditor";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { pendingDesignDrafts, readPendingDesignDocuments, clearPendingAuthoringDrafts } from "./authoring-drafts";
import { createProjectDesignDocuments, designDocumentsKey, readProjectDesignDocuments, saveProjectDesignDocuments, type ProjectDesignDocuments } from "./design-artifacts";
import { DESIGN_BRIDGE } from "./design-editor-bridge";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {}, sequence = 0;
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });
async function mount(overrides: Partial<DesignEditorProps> = {}) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const props: DesignEditorProps = { projectId: `design-ui-${++sequence}`, onSelection: vi.fn(), onDocumentsChange: vi.fn(), ...overrides };
  const render = async (next: Partial<DesignEditorProps> = {}) => { Object.assign(props, next); await act(async () => root.render(createElement(DesignEditor, props))); };
  dispose = () => act(() => root.unmount()); await render();
  return { node, props, render, state: () => (props.onDocumentsChange as ReturnType<typeof vi.fn>).mock.lastCall![0] as ProjectDesignDocuments };
}
function button(node: ParentNode, text: string) { const found = [...node.querySelectorAll("button")].find(item => item.textContent === text); if (!found) throw Error(`Missing button ${text}`); return found; }
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
const field = <T extends HTMLElement>(node: ParentNode, label: string) => node.querySelector<T>(`[aria-label="${label}"]`)!;
async function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function select(node: HTMLSelectElement, value: string) { await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function message(node: ParentNode, data: Record<string, unknown>, correct = true) {
  const frame = field<HTMLIFrameElement>(node, "unused") || node.querySelector<HTMLIFrameElement>('iframe[title="设计预览"]')!;
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: correct ? frame.contentWindow : window, data: { type: DESIGN_BRIDGE, generation: frame.dataset.designGeneration, ...data } })));
}
function current(work: Awaited<ReturnType<typeof mount>>) { const state = work.state(), doc = state.documents.find(item => item.id === state.activeId)!; return { doc, page: doc.pages.find(item => item.id === doc.activePageId)! }; }
async function submit(node: HTMLFormElement) { await act(async () => node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

it.each(["批注", "新设计名称", "文档标题", "页标题", "源码中文输入", "源码 DOM 不同步", "属性", "属性中文输入", "备注 DOM 不同步"])("只读离开检查覆盖%s，保留本机数据与局部表单", async variant => {
  const work = await mount();
  if (variant === "备注 DOM 不同步") await select(field(work.node, "切换设计文档"), work.state().documents[2]!.id);
  await click(button(work.node, "保存"));
  const id = work.props.projectId, before = localStorage.getItem(designDocumentsKey(id));
  if (variant === "批注") {
    await click(work.node.querySelector<HTMLButtonElement>(".design-comment-toggle")!);
    await message(work.node, { action: "comment", x: 20, y: 30, nodeId: "page-title" });
    await input(field(work.node, "批注内容"), "未点击保存批注的意见");
  } else if (variant === "新设计名称") {
    await click(button(work.node, "新建设计")); await input(field(work.node, "新设计名称"), "尚未创建设计");
  } else if (variant === "文档标题" || variant === "页标题") {
    await input(field(work.node, variant === "文档标题" ? "设计文档标题" : "页面标题"), "未 blur 的标题");
  } else if (variant.startsWith("属性")) {
    await message(work.node, { action: "select", nodeId: "page-description", nodeIds: ["page-description"] });
    if (variant === "属性中文输入") await act(async () => field(work.node, "元素文字").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    else await input(field(work.node, "元素文字"), "未应用的元素属性");
  } else if (variant === "备注 DOM 不同步") field<HTMLTextAreaElement>(work.node, "演讲备注").value = "未同步备注";
  else {
    await click(button(work.node, "HTML 源码")); const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码");
    if (variant.endsWith("中文输入")) await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    else source.value = "<p>尚未同步的源码</p>";
  }
  expect(pendingDesignDrafts.has(id)).toBe(false);
  for (let repeat = 0; repeat < 2; repeat++) expect(() => assertAuthoringCanLeave([id])).toThrow();
  expect(localStorage.getItem(designDocumentsKey(id))).toBe(before); expect(pendingDesignDrafts.has(id)).toBe(false);
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
});
it("隐藏设计的批注门禁在真实保存后解除，不把保存文档当作保存批注", async () => {
  const work = await mount(); await click(button(work.node, "保存")); work.node.hidden = true;
  const id = work.props.projectId;
  await click(work.node.querySelector<HTMLButtonElement>(".design-comment-toggle")!);
  await message(work.node, { action: "comment", x: 10, y: 20, nodeId: "page-title" }); await input(field(work.node, "批注内容"), "必须保留的意见");
  await click(button(work.node, "保存")); expect(() => assertAuthoringCanLeave([id])).toThrow("批注尚未保存");
  await click(button(work.node, "保存批注")); expect(() => assertAuthoringCanLeave([id])).toThrow();
  await click(button(work.node, "保存")); expect(() => assertAuthoringCanLeave([id])).not.toThrow();
  expect(readProjectDesignDocuments(id).documents[0]!.pages[0]!.annotations![0]!.text).toBe("必须保留的意见");
});

it("属性面板可保存字体、圆角、阴影和旋转；未应用输入能还原，提交可一次撤销", async () => {
  const work = await mount(); await click(button(work.node, "保存"));
  await message(work.node, { action: "select", nodeId: "page-description", nodeIds: ["page-description"] });
  await input(field(work.node, "字体"), "Arial, sans-serif"); await input(field(work.node, "圆角"), "12px");
  expect(() => assertAuthoringCanLeave([work.props.projectId])).toThrow("属性尚未应用");
  await click(button(work.node, "还原属性输入")); expect(field<HTMLInputElement>(work.node, "圆角").value).toBe("");
  expect(() => assertAuthoringCanLeave([work.props.projectId])).not.toThrow();
  const before = current(work).page.html;
  for (const [label, value] of [["字体", "Arial, sans-serif"], ["圆角", "12px"], ["阴影", "0 4px 16px #00000033"], ["旋转", "15deg"]] as const) await input(field(work.node, label), value);
  await submit(work.node.querySelector<HTMLFormElement>(".design-inspector form")!);
  const after = current(work).page.html; expect(after).toContain("border-radius: 12px"); expect(after).toContain("rotate: 15deg"); expect(after).toContain("font-family: Arial, sans-serif");
  await click(button(work.node, "撤销")); expect(current(work).page.html).toBe(before);
  await click(button(work.node, "重做")); expect(current(work).page.html).toBe(after);
  await click(button(work.node, "保存")); expect(readProjectDesignDocuments(work.props.projectId).documents[0]!.pages[0]!.html).toBe(after);
});
it("edits actual selected static text via bridge, ignores forged source, unifies source undo/redo and persists refresh", async () => {
  const work = await mount(); const before = current(work).page.html;
  await message(work.node, { action: "select", nodeId: "page-title", nodeIds: ["page-title"] }, false);
  expect(field(work.node, "元素文字")).toBeNull();
  await message(work.node, { action: "select", nodeId: "page-description", nodeIds: ["page-description"] });
  expect(work.props.onSelection).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "page-description", editable: true }));
  await input(field(work.node, "元素文字"), "真实修改后的中文页面"); await submit(work.node.querySelector<HTMLFormElement>(".design-inspector form")!);
  expect(current(work).page.html).toContain("真实修改后的中文页面"); expect(current(work).page.html).not.toContain("data-design-overlay");
  await click(button(work.node, "撤销")); expect(current(work).page.html).toBe(before);
  await click(button(work.node, "重做")); expect(current(work).page.html).toContain("真实修改后的中文页面");
  await click(button(work.node, "HTML 源码")); const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码");
  await input(source, '<h1 data-design-id="custom">源码与可视同源</h1>'); await click(button(work.node, "撤销")); expect(source.value).toContain("真实修改后的中文页面");
  await click(button(work.node, "重做")); await click(button(work.node, "保存"));
  const raw = readProjectDesignDocuments(work.props.projectId); expect(raw.documents[0]!.pages[0]!.html).toContain("源码与可视同源");
  dispose(); work.node.remove(); const reloaded = await mount({ projectId: work.props.projectId }); expect(current(reloaded).page.html).toContain("源码与可视同源");
});
it("adds, duplicates, reorders slides by real drag/drop, saves notes, deletes with confirmation and presents", async () => {
  const work = await mount(); await select(field(work.node, "切换设计文档"), work.state().documents[2]!.id);
  expect(current(work).doc.pages).toHaveLength(3); await input(field(work.node, "演讲备注"), "这一页讲述重点");
  await click(button(work.node, "复制页")); expect(current(work).doc.pages).toHaveLength(4); expect(current(work).page.notes).toBe("这一页讲述重点");
  const before = current(work).doc.pages.map(page => page.id), rows = work.node.querySelectorAll<HTMLElement>(".design-page-row");
  await act(async () => { rows[0]!.dispatchEvent(new Event("dragstart", { bubbles: true })); rows[3]!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })); });
  expect(current(work).doc.pages[3]!.id).toBe(before[0]); await click(button(work.node, "撤销")); expect(current(work).doc.pages.map(page => page.id)).toEqual(before);
  await click(button(work.node, "新增页")); expect(current(work).doc.pages).toHaveLength(5);
  await click(button(work.node, "删除页")); expect(current(work).doc.pages).toHaveLength(5); await click(button(work.node, "确认删除页")); expect(current(work).doc.pages).toHaveLength(4);
  await click(button(work.node, "播放演示")); expect(work.node.querySelector(".design-presenting")).not.toBeNull(); await click(button(work.node, "下一页"));
  await act(async () => work.node.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(work.node.querySelector(".design-presenting")).toBeNull(); await click(button(work.node, "保存")); expect(readProjectDesignDocuments(work.props.projectId).documents[2]!.pages[0]!.notes).toBe("这一页讲述重点");
});
it("applies bridge movement/resize, lock and responsive view without admitting arbitrary messages", async () => {
  const work = await mount(); await message(work.node, { action: "select", nodeId: "page-description", nodeIds: ["page-description"] });
  await message(work.node, { action: "gesture", nodeId: "page-description", nodeIds: ["page-description"], dx: 20, dy: 12 }); expect(current(work).page.html).toContain("left: 20px");
  await message(work.node, { action: "gesture", nodeId: "page-description", nodeIds: ["page-description"], dx: 0, dy: 0, width: 320, height: 110 }); expect(current(work).page.html).toContain("width: 320px");
  await click(button(work.node, "锁定元素")); const locked = current(work).page.html;
  await message(work.node, { action: "gesture", nodeId: "page-description", nodeIds: ["page-description"], dx: 200, dy: 0 }); expect(current(work).page.html).toBe(locked);
  await message(work.node, { action: "eval", code: "bad" }); expect(current(work).page.html).toBe(locked);
  await select(field(work.node, "响应式预览尺寸"), "mobile"); expect(work.node.textContent).toContain("390 × 844");
  const frame = work.node.querySelector<HTMLIFrameElement>('iframe[title="设计预览"]')!; expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
});
it("preserves corrupt and concurrent old bytes, quota draft then retries", async () => {
  const projectId = `corrupt-${++sequence}`, key = designDocumentsKey(projectId); localStorage.setItem(key, "{broken"); const broken = await mount({ projectId });
  await click(button(broken.node, "保存")); expect(localStorage.getItem(key)).toBe("{broken"); expect(broken.node.querySelector('[role="alert"]')!.textContent).toContain("旧设计文档未安全读取");
  dispose(); broken.node.remove(); const work = await mount(); await click(button(work.node, "保存"));
  const raw = localStorage.getItem(designDocumentsKey(work.props.projectId)); await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>未保存草稿</p>");
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); }); await click(button(work.node, "保存"));
  expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw); expect(work.node.textContent).toContain("空间不足"); fail.mockRestore(); await click(button(work.node, "重试保存"));
  expect(readProjectDesignDocuments(work.props.projectId).documents[0]!.pages[0]!.html).toBe("<p>未保存草稿</p>");
  const other = readProjectDesignDocuments(work.props.projectId); other.documents[0]!.title = "对方更新"; saveProjectDesignDocuments(other);
  await input(field(work.node, "页面 HTML 源码"), "<p>本窗口新稿</p>"); await click(button(work.node, "保存")); expect(work.node.textContent).toContain("其他窗口"); expect(readProjectDesignDocuments(work.props.projectId).documents[0]!.title).toBe("对方更新");
});
it("imports a real local HTML file as new page, retains prototype code, and exports current context only via callback", async () => {
  const onExport = vi.fn(), work = await mount({ onExport });
  const html = '<main><h1>本地导入</h1><script>window.localPrototype=true</script></main>';
  const file = new File([html], "本地原型.html", { type: "text/html" }); Object.defineProperty(file, "text", { value: async () => html });
  const inputFile = field<HTMLInputElement>(work.node, "导入本地 HTML"); Object.defineProperty(inputFile, "files", { value: [file], configurable: true });
  await act(async () => { inputFile.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(current(work).doc.pages).toHaveLength(2); expect(current(work).page.html).toContain("window.localPrototype=true"); expect(current(work).page.html).toContain("data-design-id");
  await click(button(work.node, "导出")); expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ state: work.state(), document: current(work).doc, page: current(work).page }));
});
it("opens only requested kind and safely accepts same-project external revisions without losing local dirty work", async () => {
  const work = await mount({ initialKind: "slides" }); expect(work.state().documents).toHaveLength(1); expect(current(work).doc.kind).toBe("slides");
  await click(button(work.node, "保存")); const external = structuredClone(work.state()); external.documents[0]!.pages[0]!.html = '<h1 data-design-id="external">Git 恢复内容</h1>';
  saveProjectDesignDocuments(external); await work.render({ externalState: external, revision: 1 }); expect(current(work).page.html).toContain("Git 恢复内容");
  await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>本地未保存</p>");
  const newer = structuredClone(external); newer.documents[0]!.pages[0]!.html = "<p>AI 新版本</p>"; await work.render({ externalState: newer, revision: 2 });
  expect(current(work).page.html).toBe("<p>本地未保存</p>"); expect(work.node.textContent).toContain("本地有未保存修改");
});
it("恢复预检允许已确认设计脏稿且不改变状态，accept 无 I/O、清历史且只接收一次", async () => {
  vi.useFakeTimers();
  try {
    const editHandle: { current: DesignEditHandle | null } = { current: null }, historyChanged = vi.fn();
    const work = await mount({ editHandle, onHistoryChange: historyChanged });
    await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码"));
    await input(field(work.node, "页面 HTML 源码"), "<p>Git 已备份的未保存草稿</p>");
    const expected = structuredClone(work.state()), next = createProjectDesignDocuments(work.props.projectId, "恢复设计", "slides");
    next.documents[0]!.activePageId = next.documents[0]!.pages[1]!.id; next.documents[0]!.pages[1]!.html = "<h1>恢复后的第二页</h1>";
    const snapshot = structuredClone(next), raw = JSON.stringify(snapshot), oldRaw = localStorage.getItem(designDocumentsKey(work.props.projectId));
    const calls = (work.props.onDocumentsChange as ReturnType<typeof vi.fn>).mock.calls.length;
    const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
    const handle = editHandle.current!, accept = handle.prepareRestore!(next, expected);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); get.mockRestore(); put.mockRestore();
    expect(work.state()).toEqual(expected); expect(handle.canUndo).toBe(true);
    expect(field<HTMLTextAreaElement>(work.node, "页面 HTML 源码").value).toContain("未保存草稿");
    expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(oldRaw);
    next.documents[0]!.pages[1]!.html = "调用方后来修改，不得污染冻结快照";
    localStorage.setItem(designDocumentsKey(work.props.projectId), raw);
    await act(async () => {
      const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
      accept(); accept();
      expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
      expect(handle.canUndo).toBe(false); expect(handle.canRedo).toBe(false);
      get.mockRestore(); put.mockRestore();
    });
    expect(work.props.onDocumentsChange).toHaveBeenCalledTimes(calls + 1); expect(work.state()).toEqual(snapshot);
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
    const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码"); expect(source.value).toBe("<h1>恢复后的第二页</h1>"); expect(source.selectionStart).toBe(0);
    expect(work.props.onSelection).toHaveBeenLastCalledWith({ documentId: snapshot.activeId, pageId: snapshot.documents[0]!.activePageId, nodeId: "", nodeIds: [], text: "" });
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw);
    await input(source, "<p>恢复后继续编辑</p>"); await act(async () => accept());
    expect(source.value).toBe("<p>恢复后继续编辑</p>"); expect(handle.canUndo).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(readProjectDesignDocuments(work.props.projectId).documents[0]!.pages[1]!.html).toBe(source.value);
    const projectId = work.props.projectId; await work.render({ projectId: `other-${++sequence}` }); await work.render({ projectId });
    expect(current(work).page.html).toBe("<p>恢复后继续编辑</p>"); expect(work.node.querySelector('[role="alert"]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("恢复预检拒绝 IME、source DOM 不同步、完整 expected 过期和已卸载旧句柄", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  await click(button(work.node, "HTML 源码"));
  const expected = structuredClone(work.state()), next = createProjectDesignDocuments(work.props.projectId), handle = editHandle.current!;
  const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码"), raw = localStorage.getItem(designDocumentsKey(work.props.projectId));
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(() => handle.prepareRestore!(next, expected)).toThrow(/完成中文输入/);
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  source.value = "未触发 input 的源码"; expect(() => handle.prepareRestore!(next, expected)).toThrow(/不同步/); source.value = current(work).page.html;
  const stale = structuredClone(expected); stale.documents[1]!.pages[0]!.notes = "其他文档页面也须核对";
  expect(() => handle.prepareRestore!(next, stale)).toThrow(/过期/);
  expect(() => handle.prepareRestore!(next, { ...expected, activeId: expected.documents[1]!.id })).toThrow(/过期/);
  expect(work.state()).toEqual(expected); expect(handle.canUndo).toBe(false); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw);
  const accept = handle.prepareRestore!(next, expected);
  await work.render({ projectId: `other-${++sequence}` }); expect(() => handle.prepareRestore!(next, expected)).toThrow(/已卸载/);
  const before = work.state(); await act(async () => accept()); expect(work.state()).toBe(before);
});

it.each([
  ["空设计", (value: ProjectDesignDocuments) => { value.documents = []; value.activeId = ""; }],
  ["错误项目", (value: ProjectDesignDocuments) => { value.projectId = "other"; }],
  ["错误 activeId", (value: ProjectDesignDocuments) => { value.activeId = "missing"; }],
  ["重复文档", (value: ProjectDesignDocuments) => { value.documents.push(value.documents[0]!); }],
  ["无页面", (value: ProjectDesignDocuments) => { value.documents[0]!.pages = []; }],
] as const)("恢复预检拒绝%s且无副作用", async (_label, mutate) => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  const expected = structuredClone(work.state()), next = structuredClone(expected); mutate(next);
  const raw = localStorage.getItem(designDocumentsKey(work.props.projectId)), calls = (work.props.onDocumentsChange as ReturnType<typeof vi.fn>).mock.calls.length;
  expect(() => editHandle.current!.prepareRestore!(next, expected)).toThrow();
  expect(work.state()).toEqual(expected); expect(work.props.onDocumentsChange).toHaveBeenCalledTimes(calls);
  expect(editHandle.current!.canUndo).toBe(false); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw);
});

it("accept 清除设计 pending draft，立即重开不复活旧稿，后续 AI apply/undo 仍正常", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>旧缓存草稿</p>");
  const next = createProjectDesignDocuments(work.props.projectId, "恢复稿", "page");
  const accept = editHandle.current!.prepareRestore!(next, work.state()); saveProjectDesignDocuments(next); await act(async () => accept());
  const projectId = work.props.projectId; await work.render({ projectId: `other-${++sequence}` }); await work.render({ projectId });
  expect(work.state()).toEqual(next); expect(editHandle.current!.canUndo).toBe(false);
  const before = structuredClone(current(work).doc), after = { ...before, title: "AI 改标题" };
  await act(async () => { expect(editHandle.current!.apply(before, after)).toBe(true); }); expect(current(work).doc.title).toBe("AI 改标题");
  await act(async () => editHandle.current!.undo()); expect(current(work).doc.title).toBe(before.title);
  await act(async () => editHandle.current!.redo()); expect(current(work).doc.title).toBe("AI 改标题");
});

it("空设计恢复停用无 I/O、不渲染空 state，批量卸载重开不复活 module 草稿", async () => {
  vi.useFakeTimers();
  try {
    const projectId = `deactivate-design-${++sequence}`, initial = createProjectDesignDocuments(projectId); saveProjectDesignDocuments(initial);
    const editHandle: { current: DesignEditHandle | null } = { current: null }, changed = vi.fn();
    const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
    dispose = () => act(() => root.unmount());
    let visit!: (value: boolean) => void;
    function Harness() {
      const [visited, setVisited] = useState(true); visit = setVisited;
      return visited ? createElement(DesignEditor, { projectId, editHandle, onDocumentsChange: changed }) : null;
    }
    await act(async () => root.render(createElement(Harness))); await click(button(node, "HTML 源码"));
    await input(field(node, "页面 HTML 源码"), "<p>恢复空设计前的未保存缓存</p>");
    const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDesignDocuments, handle = editHandle.current!;
    const calls = changed.mock.calls.length, raw = localStorage.getItem(designDocumentsKey(projectId));
    const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
    const deactivate = handle.prepareDeactivate!(expected);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(handle.canUndo).toBe(true);
    expect(changed).toHaveBeenCalledTimes(calls); expect(field<HTMLTextAreaElement>(node, "页面 HTML 源码").value).toContain("未保存缓存");
    get.mockRestore(); put.mockRestore(); expect(localStorage.getItem(designDocumentsKey(projectId))).toBe(raw);
    const empty: ProjectDesignDocuments = { version: 1, projectId, documents: [], activeId: "" }, emptyRaw = JSON.stringify(empty);
    await act(async () => {
      localStorage.setItem(designDocumentsKey(projectId), emptyRaw);
      const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
      deactivate(); deactivate(); expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
      expect(handle.canUndo).toBe(false); expect(handle.canRedo).toBe(false); expect(changed).toHaveBeenCalledTimes(calls);
      expect(field<HTMLTextAreaElement>(node, "页面 HTML 源码").value).toContain("未保存缓存");
      get.mockRestore(); put.mockRestore(); visit(false);
    });
    expect(editHandle.current).toBeNull(); expect(node.querySelector("textarea")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(localStorage.getItem(designDocumentsKey(projectId))).toBe(emptyRaw);
    await act(async () => visit(true));
    const fresh = changed.mock.lastCall![0] as ProjectDesignDocuments;
    expect(fresh.documents.map(doc => doc.id)).not.toContain(expected.activeId);
    expect(JSON.stringify(fresh)).not.toContain("未保存缓存"); expect(editHandle.current!.canUndo).toBe(false);
    expect(node.querySelector('[role="alert"]')).toBeNull();
    await click(button(node, "HTML 源码")); await input(field(node, "页面 HTML 源码"), "<p>重新打开后新设计</p>");
    await act(async () => deactivate()); expect(field<HTMLTextAreaElement>(node, "页面 HTML 源码").value).toContain("新设计");
    await click(button(node, "保存")); expect(readProjectDesignDocuments(projectId).documents[0]!.pages[0]!.html).toBe("<p>重新打开后新设计</p>");
  } finally { vi.useRealTimers(); }
});

it("设计停用后旧自动保存计时器和手动保存均不回写旧稿或重新缓存", async () => {
  vi.useFakeTimers();
  try {
    const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
    await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>不得由旧计时器回写的设计</p>");
    const deactivate = editHandle.current!.prepareDeactivate!(work.state());
    const empty: ProjectDesignDocuments = { version: 1, projectId: work.props.projectId, documents: [], activeId: "" }, raw = JSON.stringify(empty);
    localStorage.setItem(designDocumentsKey(work.props.projectId), raw);
    const calls = (work.props.onDocumentsChange as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => deactivate()); await click(button(work.node, "保存")); await act(async () => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw); expect(work.props.onDocumentsChange).toHaveBeenCalledTimes(calls);
    expect(field<HTMLTextAreaElement>(work.node, "页面 HTML 源码").value).toContain("不得由旧计时器回写");
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
    dispose(); work.node.remove(); const reopened = await mount({ projectId: work.props.projectId });
    expect(JSON.stringify(reopened.state())).not.toContain("不得由旧计时器回写");
  } finally { vi.useRealTimers(); }
});

it("设计停用复用恢复预检，拒绝 IME、DOM 不同步、过期 expected 和卸载句柄", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>应保留的设计草稿</p>");
  const expected = structuredClone(work.state()), handle = editHandle.current!, projectId = work.props.projectId;
  const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码"), raw = localStorage.getItem(designDocumentsKey(projectId));
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(() => handle.prepareDeactivate!(expected)).toThrow(/完成中文输入/); expect(handle.canUndo).toBe(true);
  expect(source.value).toBe("<p>应保留的设计草稿</p>");
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  source.value = "DOM 暂未同步"; expect(() => handle.prepareDeactivate!(expected)).toThrow(/不同步/); source.value = current(work).page.html;
  const stale = structuredClone(expected); stale.documents[1]!.title = "其他文档的过期标题";
  expect(() => handle.prepareDeactivate!(stale)).toThrow(/过期/); expect(localStorage.getItem(designDocumentsKey(projectId))).toBe(raw);
  const deactivate = handle.prepareDeactivate!(expected);
  await work.render({ projectId: `other-${++sequence}` }); expect(() => handle.prepareDeactivate!(expected)).toThrow(/已卸载/);
  await act(async () => deactivate()); await work.render({ projectId });
  expect(current(work).page.html).toBe("<p>应保留的设计草稿</p>");
});

it.each(["非空", "显式空"] as const)("未挂载设计优先读取 pending 用于备份，成功恢复%s后定向清理不复活", async kind => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  await click(button(work.node, "保存")); const initial = readProjectDesignDocuments(work.props.projectId);
  await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>A 项目未落盘的待备份设计</p>");
  const expected = structuredClone(work.state()), projectId = work.props.projectId;
  await work.render({ projectId: `other-${++sequence}` }); dispose(); work.node.remove(); dispose = () => {};
  expect(editHandle.current).toBeNull(); expect(readProjectDesignDocuments(projectId)).toEqual(initial);
  const backup = readPendingDesignDocuments(projectId) ?? readProjectDesignDocuments(projectId);
  expect(backup).toEqual(expected); backup.documents[0]!.pages[0]!.html = "修改备份副本不得污染缓存";
  expect(readPendingDesignDocuments(projectId)).toEqual(expected);
  const next: ProjectDesignDocuments = kind === "显式空" ? { version: 1, projectId, documents: [], activeId: "" } : createProjectDesignDocuments(projectId);
  if (next.documents.length) next.documents[0]!.pages[0]!.html = "<p>Git 恢复的新设计</p>";
  saveProjectDesignDocuments(next, undefined, JSON.stringify(initial)); clearPendingAuthoringDrafts(projectId, { design: true });
  expect(readPendingDesignDocuments(projectId)).toBeUndefined();
  const raw = localStorage.getItem(designDocumentsKey(projectId)), reopened = await mount({ projectId });
  expect(JSON.stringify(reopened.state())).not.toContain("待备份设计");
  if (kind === "非空") expect(current(reopened).page.html).toBe("<p>Git 恢复的新设计</p>");
  else expect(reopened.state().documents.map(doc => doc.id)).not.toContain(expected.activeId);
  expect(localStorage.getItem(designDocumentsKey(projectId))).toBe(raw);
});

it("未挂载设计恢复写入失败保留 pending、raw 和错误，重新打开仍是完整草稿", async () => {
  const work = await mount(); await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码"));
  await input(field(work.node, "页面 HTML 源码"), "<p>恢复失败必须保留的未落盘设计</p>");
  const expected = structuredClone(work.state()), projectId = work.props.projectId;
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await click(button(work.node, "保存")); fail.mockRestore();
  const draft = pendingDesignDrafts.get(projectId)!; expect(draft.error).not.toBe("");
  await work.render({ projectId: `other-${++sequence}` }); dispose(); work.node.remove(); dispose = () => {};
  const raw = localStorage.getItem(designDocumentsKey(projectId));
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => { saveProjectDesignDocuments(createProjectDesignDocuments(projectId), undefined, raw); clearPendingAuthoringDrafts(projectId, { design: true }); }).toThrow();
  write.mockRestore(); expect(pendingDesignDrafts.get(projectId)).toBe(draft); expect(readPendingDesignDocuments(projectId)).toEqual(expected);
  expect(localStorage.getItem(designDocumentsKey(projectId))).toBe(raw);
  const reopened = await mount({ projectId }); expect(current(reopened).page.html).toBe("<p>恢复失败必须保留的未落盘设计</p>");
  expect(reopened.node.querySelector('[role="alert"]')!.textContent).toContain(draft.error);
});

it("恢复 expected 使用语义指纹，且可在可视模式预检", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  const state = work.state(), expected = { activeId: state.activeId, documents: state.documents, projectId: state.projectId, version: state.version };
  expect(() => editHandle.current!.prepareRestore!(createProjectDesignDocuments(work.props.projectId), expected)).not.toThrow();
});

it("设计 revision=0 父回送不打断输入或清历史，相同 revision 不重复接收", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null };
  const projectId = `parent-echo-${++sequence}`, initial = createProjectDesignDocuments(projectId); saveProjectDesignDocuments(initial);
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); dispose = () => act(() => root.unmount());
  let restore!: (next: ProjectDesignDocuments) => void, snapshot!: ProjectDesignDocuments;
  function Harness() {
    const [value, setValue] = useState(initial), [revision, setRevision] = useState(0);
    restore = next => { setValue(next); setRevision(value => value + 1); };
    return createElement(DesignEditor, { projectId, editHandle, externalState: value, revision, onDocumentsChange: next => { snapshot = next; setValue(next); } });
  }
  await act(async () => root.render(createElement(Harness))); await click(button(node, "HTML 源码"));
  const source = field<HTMLTextAreaElement>(node, "页面 HTML 源码"); await input(source, "<p>人工输入</p>");
  expect(source.value).toBe("<p>人工输入</p>"); expect(node.querySelector('[role="alert"]')).toBeNull(); expect(editHandle.current!.canUndo).toBe(true);
  await click(button(node, "保存")); await act(async () => restore(structuredClone(snapshot)));
  expect(editHandle.current!.canUndo).toBe(true); await click(button(node, "撤销")); expect(source.value).toBe(initial.documents[0]!.pages[0]!.html);
  expect(editHandle.current!.canRedo).toBe(true); expect(node.querySelector('[role="alert"]')).toBeNull();
});

it("设计 IME 暂存最新 revision，父回送和旧 revision 不替换挂起快照", async () => {
  const work = await mount(); await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码"));
  const initial = structuredClone(work.state()), first = structuredClone(initial), latest = structuredClone(initial);
  first.documents[0]!.pages[0]!.html = "<p>旧外部稿</p>"; latest.documents[0]!.pages[0]!.html = "<p>最新外部稿</p>";
  const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码");
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await work.render({ externalState: first, revision: 1 }); await work.render({ externalState: latest, revision: 2 });
  await work.render({ externalState: initial }); expect(source.value).toBe(initial.documents[0]!.pages[0]!.html);
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(source.value).toBe("<p>最新外部稿</p>"); await click(button(work.node, "保存"));
  await work.render({ externalState: first, revision: 1 }); expect(source.value).toBe("<p>最新外部稿</p>");
});

it("设计 IME 结束重新检查 dirty，保留中文与一次撤销，旧 revision 不再应用", async () => {
  const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
  await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码"));
  const before = current(work).page.html, external = structuredClone(work.state()); external.documents[0]!.pages[0]!.html = "<p>外部恢复</p>";
  const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码"), raw = localStorage.getItem(designDocumentsKey(work.props.projectId));
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await work.render({ externalState: external, revision: 2 }); await input(source, "中文组合输入"); await input(source, "中文组合输入完成");
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(source.value).toBe("中文组合输入完成"); expect(work.node.textContent).toContain("未保存修改");
  expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw); expect(editHandle.current!.canUndo).toBe(true);
  await click(button(work.node, "保存")); await work.render({ externalState: structuredClone(external), revision: 2 });
  await work.render({ externalState: external, revision: 1 }); expect(source.value).toBe("中文组合输入完成");
  await click(button(work.node, "撤销")); expect(source.value).toBe(before); expect(editHandle.current!.canUndo).toBe(false);
});

it("设计无 revision 兼容初始外部状态，revision 模式不因无 undo 放行未保存状态", async () => {
  const work = await mount(), external = structuredClone(work.state()); external.documents[0]!.pages[0]!.html = "<p>兼容外部初稿</p>";
  await work.render({ externalState: external }); expect(current(work).page.html).toBe("<p>兼容外部初稿</p>");
  const newer = structuredClone(external); newer.documents[0]!.pages[0]!.html = "<p>不覆盖尚未保存的接收稿</p>";
  await work.render({ externalState: newer, revision: 1 }); expect(current(work).page.html).toBe("<p>兼容外部初稿</p>"); expect(work.node.textContent).toContain("未保存修改");
});

it("设计 external revision 拒绝未同步 DOM 与损坏磁盘，不改 current 或存储", async () => {
  const work = await mount(); await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码"));
  const before = structuredClone(work.state()), external = structuredClone(before); external.documents[0]!.pages[0]!.html = "<p>外部稿</p>";
  const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码"), raw = localStorage.getItem(designDocumentsKey(work.props.projectId));
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await work.render({ externalState: external, revision: 1 }); source.value = "未触发事件的输入";
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(work.state()).toEqual(before); expect(work.node.textContent).toContain("未保存修改"); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw);
  source.value = before.documents[0]!.pages[0]!.html; localStorage.setItem(designDocumentsKey(work.props.projectId), "{corrupt");
  await work.render({ externalState: external, revision: 2 }); expect(work.state()).toEqual(before);
  expect(work.node.textContent).toContain("损坏"); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe("{corrupt");
});

it.each([0, -1, NaN, Infinity])("设计忽略非恢复 revision %s，不干扰当前输入", async revision => {
  const work = await mount(); await click(button(work.node, "保存"));
  const before = structuredClone(work.state()), external = structuredClone(before); external.documents[0]!.pages[0]!.html = "不得接收";
  await work.render({ externalState: external, revision }); expect(work.state()).toEqual(before); expect(work.node.querySelector('[role="alert"]')).toBeNull();
});

it("相同设计脏稿回送不接管其他窗口 baseline，同稿磁盘确认不重写 bytes 或清历史", async () => {
  vi.useFakeTimers();
  try {
    const editHandle: { current: DesignEditHandle | null } = { current: null }, work = await mount({ editHandle });
    await click(button(work.node, "保存")); await click(button(work.node, "HTML 源码")); await input(field(work.node, "页面 HTML 源码"), "<p>本窗口稿</p>");
    const own = structuredClone(work.state()), other = structuredClone(own); other.documents[0]!.pages[0]!.html = "<p>其他窗口稿</p>"; saveProjectDesignDocuments(other);
    const otherRaw = localStorage.getItem(designDocumentsKey(work.props.projectId)); await work.render({ externalState: own, revision: 1 }); await click(button(work.node, "保存"));
    expect(work.node.textContent).toContain("其他窗口"); expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(otherRaw);
    const raw = JSON.stringify(own, null, 2); localStorage.setItem(designDocumentsKey(work.props.projectId), raw);
    await work.render({ externalState: structuredClone(own), revision: 2 }); await act(async () => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem(designDocumentsKey(work.props.projectId))).toBe(raw); expect(editHandle.current!.canUndo).toBe(true);
    await input(field(work.node, "页面 HTML 源码"), "<p>正常后续编辑</p>"); await click(button(work.node, "保存")); expect(work.node.querySelector('[role="alert"]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("keeps IME shortcuts and Tab navigation intact, restores unsaved project draft on project switch", async () => {
  const work = await mount(); await click(button(work.node, "HTML 源码")); const source = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码");
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await input(source, "中文输入中");
  const key = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }); await act(async () => source.dispatchEvent(key)); expect(key.defaultPrevented).toBe(false);
  await act(async () => source.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); await act(async () => source.dispatchEvent(tab)); expect(tab.defaultPrevented).toBe(false);
  const first = work.props.projectId; await work.render({ projectId: `other-${++sequence}` }); await work.render({ projectId: first }); expect(current(work).page.html).toBe("中文输入中");
});

it("编组、整体移动、撤销重做和保存重开保持同一份源码", async () => {
  const work = await mount();
  await click(button(work.node, "HTML 源码"));
  await input(field(work.node, "页面 HTML 源码"), '<main><div data-design-id="a" style="position:absolute;left:10px;top:20px">甲</div><div data-design-id="b" style="position:absolute;left:100px;top:80px">乙</div></main>');
  await click(button(work.node, "可视编辑"));
  await message(work.node, { action: "select", nodeId: "a", nodeIds: ["a", "b"] });
  await click(button(work.node, "编组"));
  const grouped = current(work).page.html;
  expect(grouped.match(/data-design-group="group-1"/g)).toHaveLength(2);
  await message(work.node, { action: "gesture", nodeId: "a", nodeIds: ["a"], dx: 20, dy: 10 });
  const moved = current(work).page.html;
  expect(moved).toContain("left: 30px"); expect(moved).toContain("left: 120px");
  await click(button(work.node, "撤销")); expect(current(work).page.html).toBe(grouped);
  await click(button(work.node, "重做")); expect(current(work).page.html).toBe(moved);
  await click(button(work.node, "保存"));
  const projectId = work.props.projectId;
  dispose(); work.node.remove();
  const reopened = await mount({ projectId }); expect(current(reopened).page.html).toBe(moved);
  await message(reopened.node, { action: "select", nodeId: "b", nodeIds: ["b"] });
  await click(button(reopened.node, "取消编组")); expect(current(reopened).page.html).not.toContain("data-design-group");
});

it("直接编辑文字作为一次修改，可撤销重做；未提交草稿阻止离开",async()=>{
 const work=await mount();
 await message(work.node,{action:"edit",nodeId:"page-description",nodeIds:["page-description"],x:40,y:80,width:400,height:50});
 await input(field(work.node,"画面文字直接编辑"),"直接在画面修改的文字");
 expect(()=>assertAuthoringCanLeave([work.props.projectId])).toThrow("画面文字尚未应用");
 const before=current(work).page.html;
 await click(button(work.node,"应用文字"));expect(current(work).page.html).toContain("直接在画面修改的文字");
 expect(work.node.querySelector('[aria-label="画面文字直接编辑"]')).toBeNull();
 await click(button(work.node,"撤销"));expect(current(work).page.html).toBe(before);
 await click(button(work.node,"重做"));expect(current(work).page.html).toContain("直接在画面修改的文字");
});
it("切到源码后保留直接编辑草稿，迟到应用不覆盖新源码",async()=>{
 const work=await mount();
 await message(work.node,{action:"edit",nodeId:"page-description",nodeIds:["page-description"],x:40,y:80,width:400,height:50});
 await input(field(work.node,"画面文字直接编辑"),"尚未提交的旧文字");
 await click(button(work.node,"HTML 源码"));
 expect(field<HTMLTextAreaElement>(work.node,"保留的画面文字").value).toBe("尚未提交的旧文字");
 await input(field(work.node,"页面 HTML 源码"),'<p data-design-id="page-description">新的源码版本</p>');
 await click(button(work.node,"应用文字"));expect(current(work).page.html).toContain("新的源码版本");
 expect(work.node.textContent).toContain("原页面已有变化");
 await click(button(work.node,"取消直接编辑"));expect(work.node.querySelector('[aria-label="保留的画面文字"]')).toBeNull();
});

it("旋转拖柄写回 CSS rotate 并支持一次撤销，拒绝无效角度",async()=>{
 const work=await mount();const before=current(work).page.html;
 await message(work.node,{action:"gesture",nodeId:"page-description",nodeIds:["page-description"],dx:10,dy:10,rotation:45});
 expect(current(work).page.html).toContain("rotate: 45deg");
 await click(button(work.node,"撤销"));expect(current(work).page.html).toBe(before);
 await message(work.node,{action:"gesture",nodeId:"page-description",nodeIds:["page-description"],dx:10,dy:10,rotation:Infinity});
 expect(current(work).page.html).toBe(before);
});
