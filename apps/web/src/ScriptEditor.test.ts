// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { ScriptEditor, type ScriptEditorProps } from "./ScriptEditor";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { pendingScriptDrafts, readPendingScriptDocuments, clearPendingAuthoringDrafts } from "./authoring-drafts";
import { createProjectDocuments, projectDocumentsKey, readProjectDocuments, saveProjectDocuments, type ScriptEditHandle, type ProjectDocuments } from "./script-documents";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {}, sequence = 0;
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function project() { return SceneScriptProject.parse({ schemaVersion: 1, id: `script-test-${++sequence}`, title: "雨夜", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "opening", kind: "title", title: "窗前", narration: { text: "原始旁白。", durationMs: 3000 } }] }); }
async function mount(overrides: Partial<ScriptEditorProps> = {}) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const props: ScriptEditorProps = { project: project(), onSelection: vi.fn(), onDocumentsChange: vi.fn(), onBuildScenes: vi.fn(), onChangeProject: vi.fn(), ...overrides };
  const render = async (next: Partial<ScriptEditorProps> = {}) => { Object.assign(props, next); await act(async () => root.render(createElement(ScriptEditor, props))); };
  dispose = () => act(() => root.unmount()); await render(); return { node, props, render };
}
function button(node: ParentNode, text: string) { const found = [...node.querySelectorAll("button")].find(item => item.textContent === text); if (!found) throw new Error(`missing ${text}`); return found; }
const textArea = (node: ParentNode) => node.querySelector<HTMLTextAreaElement>('[aria-label="脚本文档正文"]')!;
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
async function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function select(node: HTMLSelectElement, value: string) { await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function key(node: HTMLElement, value: string, options: KeyboardEventInit = {}) { await act(async () => { node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })); }); }
async function submit(node: ParentNode) { await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
async function consent(node: ParentNode) { await click(node.querySelector<HTMLInputElement>('input[type="checkbox"]')!); }

it.each(["正文中文输入", "正文 DOM 不同步", "新建名", "重命名", "名称中文输入"])("只读离开检查保留%s，不写磁盘或清草稿", async variant => {
  const work = await mount(); await click(button(work.node, "保存"));
  const id = work.props.project.id, before = localStorage.getItem(projectDocumentsKey(id));
  if (variant.startsWith("正文")) {
    const area = textArea(work.node);
    if (variant.endsWith("中文输入")) await act(async () => area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    else area.value = "DOM 中尚未产生 onChange 的中文";
  } else {
    await click(button(work.node, variant === "重命名" ? "重命名" : "新建"));
    const name = work.node.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!;
    if (variant === "名称中文输入") await act(async () => name.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    else await input(name, "未提交名称");
  }
  expect(pendingScriptDrafts.has(id)).toBe(false);
  for (let repeat = 0; repeat < 2; repeat++) expect(() => assertAuthoringCanLeave([id])).toThrow();
  expect(localStorage.getItem(projectDocumentsKey(id))).toBe(before);
  expect(pendingScriptDrafts.has(id)).toBe(false);
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
});
it("隐藏脚本仍参与预检，通过真实保存按钮可重试，卸载后不遗留门禁", async () => {
  const work = await mount(); await click(button(work.node, "保存")); await work.render({ active: false }); work.node.hidden = true;
  const id = work.props.project.id;
  await input(textArea(work.node), "隐藏 pane 中的新正文"); expect(() => assertAuthoringCanLeave([id])).toThrow();
  await click(button(work.node, "保存")); expect(() => assertAuthoringCanLeave([id])).not.toThrow();
  expect(readProjectDocuments(id).documents.find(doc => doc.id === readProjectDocuments(id).activeId)!.content).toBe("隐藏 pane 中的新正文");
  textArea(work.node).value = "卸载前未同步"; dispose(); dispose = () => {};
  expect(() => assertAuthoringCanLeave([id])).not.toThrow();
});

it("creates an outline, renames, saves immediately via CtrlS and reloads all documents with exact active text", async () => {
  const work = project(), first = await mount({ project: work });
  expect(textArea(first.node).value).toContain("原始旁白。");
  await click(button(first.node, "新建")); await input(first.node.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!, "第二幕大纲"); await submit(first.node);
  const content = "# 人物与大纲\n\n- 雨夜归来\n林：你还好吗？\n\t结尾保留空白  \n";
  await input(textArea(first.node), content); await key(textArea(first.node), "s", { ctrlKey: true });
  expect(readProjectDocuments(work.id).documents).toHaveLength(3); expect(readProjectDocuments(work.id).documents[2]!.kind).toBe("outline");
  await click(button(first.node, "重命名")); await input(first.node.querySelector<HTMLInputElement>('[aria-label="文档名称"]')!, "雨夜大纲"); await submit(first.node); await click(button(first.node, "保存"));
  dispose(); first.node.remove(); const second = await mount({ project: work });
  expect(textArea(second.node).value).toBe(content);
  expect(second.node.querySelector<HTMLSelectElement>('[aria-label="切换脚本文档"]')!.selectedOptions[0]!.text).toContain("雨夜大纲");
  expect(second.props.onDocumentsChange).toHaveBeenCalledWith(readProjectDocuments(work.id));
});
it("requires explicit delete consent, permits cancellation and keeps one editable document", async () => {
  const { node, props } = await mount();
  await click(button(node, "删除")); expect(button(node, "确认删除").disabled).toBe(true);
  await click(button(node, "取消")); expect(node.querySelector('[aria-label="确认删除文档"]')).toBeNull();
  await click(button(node, "删除")); await consent(node); await click(button(node, "确认删除"));
  expect(button(node, "删除").disabled).toBe(true); await click(button(node, "保存"));
  expect(readProjectDocuments(props.project.id).documents).toHaveLength(1); expect(textArea(node).disabled).toBe(false);
});
it("emits exact selection context including Chinese offsets and clears context on document switch", async () => {
  const { node, props, render } = await mount(); await input(textArea(node), "中文对白：你好。\n第二行");
  await act(async () => { textArea(node).focus(); textArea(node).setSelectionRange(2, 7); textArea(node).dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(props.onSelection).toHaveBeenLastCalledWith(expect.objectContaining({ text: "对白：你好", start: 2, end: 7 }));
  const state = (props.onDocumentsChange as ReturnType<typeof vi.fn>).mock.lastCall![0];
  await render({ selectedDocumentId: state.documents[1].id });
  expect(props.onSelection).toHaveBeenLastCalledWith({ documentId: state.documents[1].id, text: "", start: 0, end: 0 });
  expect(textArea(node).value).toContain("大纲");
});
it("preserves draft and old storage on quota failure, retries and restores the full unsaved text", async () => {
  const work = project(); saveProjectDocuments(createProjectDocuments(work)); const before = localStorage.getItem(projectDocumentsKey(work.id));
  const { node } = await mount({ project: work });
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await input(textArea(node), "未保存的中文\n" + "长内容".repeat(200)); await click(button(node, "保存"));
  expect(node.querySelector('[role="alert"]')!.textContent).toContain("旧存储未覆盖"); expect(textArea(node).value).toContain("未保存的中文");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(before);
  fail.mockRestore(); await click(button(node, "重试保存")); expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(readProjectDocuments(work.id).documents[0]!.content).toBe(textArea(node).value);
});
it("never overwrites corrupt or concurrently updated stored content", async () => {
  const work = project(); localStorage.setItem(projectDocumentsKey(work.id), "{broken");
  const first = await mount({ project: work }); await input(textArea(first.node), "继续编辑仍保留"); await click(button(first.node, "保存"));
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe("{broken"); expect(textArea(first.node).value).toBe("继续编辑仍保留"); dispose(); first.node.remove();
  const second = await mount(); await click(button(second.node, "保存")); const theirs = readProjectDocuments(second.props.project.id); theirs.documents[0]!.content = "其他窗口的新稿"; saveProjectDocuments(theirs);
  await input(textArea(second.node), "本窗口稿件"); await click(button(second.node, "保存"));
  expect(second.node.querySelector('[role="alert"]')!.textContent).toContain("其他窗口");
  expect(readProjectDocuments(second.props.project.id).documents[0]!.content).toBe("其他窗口的新稿"); expect(textArea(second.node).value).toBe("本窗口稿件");
});
it("does not change project or call build before preview consent; content edits invalidate consent", async () => {
  const { node, props } = await mount(), before = JSON.stringify(props.project);
  await input(textArea(node), "# 剧本\n\n## 镜头 1\n\n夜雨。\n林：你好。\n\n## 场景 2\n\n她离开。");
  await click(button(node, "预览拆分镜头")); expect(node.textContent).toContain("2 个片段"); expect(button(node, "确认交给分镜流程").disabled).toBe(true);
  expect(props.onBuildScenes).not.toHaveBeenCalled(); expect(props.onChangeProject).not.toHaveBeenCalled(); expect(JSON.stringify(props.project)).toBe(before);
  await consent(node); await input(textArea(node), "## 镜头 3\n修改后的旁白。");
  expect(node.querySelector('[aria-label="脚本分镜预览"]')).toBeNull();
  await click(button(node, "预览拆分镜头")); expect(button(node, "确认交给分镜流程").disabled).toBe(true); await consent(node); await click(button(node, "确认交给分镜流程"));
  expect(props.onBuildScenes).toHaveBeenCalledTimes(1); expect(props.onBuildScenes).toHaveBeenCalledWith(expect.objectContaining({ content: "## 镜头 3\n修改后的旁白。" }));
  expect(props.onChangeProject).not.toHaveBeenCalled(); expect(JSON.stringify(props.project)).toBe(before);
});
it("exports actual unsaved Markdown via a real downloadable Blob, not project narration", async () => {
  let blob: Blob | undefined; const create = vi.fn((value: Blob) => { blob = value; return "blob:script"; });
  Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true }); Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  let filename = ""; vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; expect(this.href).toBe("blob:script"); });
  const { node } = await mount(); const content = "# 实际草稿\n\n**原始格式**\t你好！\n"; await input(textArea(node), content); await click(button(node, "导出 .md"));
  const decoded = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!); });
  expect(decoded).toBe(content); expect(filename).toBe("雨夜 · 脚本.md"); expect(node.textContent).toContain("含未保存修改");
});
it("键盘与按钮共用脚本历史，Tab 可撤销且 IME 中不执行快捷键", async () => {
  const { node, props } = await mount(); await input(textArea(node), "原稿");
  const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => { textArea(node).dispatchEvent(undo); }); expect(undo.defaultPrevented).toBe(true);
  expect(textArea(node).value).toContain("原始旁白");
  await key(textArea(node), "z", { ctrlKey: true, shiftKey: true }); expect(textArea(node).value).toBe("原稿");
  await act(async () => { textArea(node).focus(); textArea(node).setSelectionRange(1, 1); }); await key(textArea(node), "Tab"); expect(textArea(node).value).toBe("原\t稿");
  await key(textArea(node), "z", { ctrlKey: true }); expect(textArea(node).value).toBe("原稿"); await key(textArea(node), "y", { ctrlKey: true }); expect(textArea(node).value).toBe("原\t稿");
  await act(async () => { textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); }); await input(textArea(node), "输入中"); await key(textArea(node), "s", { ctrlKey: true, isComposing: true });
  expect(localStorage.getItem(projectDocumentsKey(props.project.id))).toBeNull();
  await act(async () => { textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); }); await click(button(node, "保存")); expect(readProjectDocuments(props.project.id).documents[0]!.content).toBe("输入中");
});
it("retains unsaved project drafts across project changes without leaking selection, consent or text", async () => {
  const first = project(), second = project(), { node, render } = await mount({ project: first }); await input(textArea(node), "项目一未保存草稿");
  await click(button(node, "预览拆分镜头")); await consent(node); await render({ project: second });
  expect(textArea(node).value).toContain("原始旁白"); expect(node.querySelector('[aria-label="脚本分镜预览"]')).toBeNull();
  await render({ project: first }); expect(textArea(node).value).toBe("项目一未保存草稿"); await click(button(node, "保存"));
  expect(readProjectDocuments(first.id).documents[0]!.content).toBe("项目一未保存草稿"); expect(readProjectDocuments(second.id).documents).toEqual([]);
});
it("整份 AI 改稿含标题和正文仅撤销一次，并可重做", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null };
  const changed = vi.fn(), historyChanged = vi.fn(), { node, props } = await mount({ editHandle, onDocumentsChange: changed, onHistoryChange: historyChanged });
  expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
  await input(textArea(node), "人工草稿");
  expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
  const before = changed.mock.lastCall![0].documents[0];
  const next = { ...before, title: "AI 标题", content: "第一幕\n第二幕\n第三幕", updatedAt: before.updatedAt + 1 };
  await act(async () => { expect(editHandle.current!.apply(before, next)).toBe(true); });
  expect(textArea(node).value).toBe(next.content); expect(editHandle.current!.canUndo).toBe(true);
  await act(async () => { editHandle.current!.undo(); });
  expect(textArea(node).value).toBe("人工草稿"); expect(changed.mock.lastCall![0].documents[0]).toEqual(before);
  expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: true, canRedo: true });
  await act(async () => { editHandle.current!.redo(); });
  expect(changed.mock.lastCall![0].documents[0]).toEqual(next);
  await click(button(node, "保存")); expect(readProjectDocuments(props.project.id).documents[0]).toEqual(next);
});
it("IME、过期、错误身份和旧项目句柄拒绝应用且不污染历史", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { node, render } = await mount({ editHandle, onDocumentsChange: changed });
  const before = changed.mock.lastCall![0].documents[0], oldHandle = editHandle.current!;
  const next = { ...before, content: "AI 新稿" };
  await act(async () => { textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  expect(oldHandle.apply(before, next)).toBe(false); expect(oldHandle.canUndo).toBe(false);
  await act(async () => { textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
  expect(oldHandle.apply(before, { ...next, id: "其他文档" })).toBe(false);
  await input(textArea(node), "新人工草稿"); expect(oldHandle.apply(before, next)).toBe(false);
  await render({ active: false });
  await act(async () => { oldHandle.undo(); });
  expect(textArea(node).value).toBe("新人工草稿");
  await render({ project: project(), active: true });
  expect(oldHandle.apply(before, next)).toBe(false); expect(editHandle.current!.canUndo).toBe(false);
});

it("撤销后新改稿清除旧重做分支，中文组合输入仅记录一次", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, historyChanged = vi.fn();
  const { node } = await mount({ editHandle, onHistoryChange: historyChanged });
  await input(textArea(node), "第一稿"); await input(textArea(node), "第二稿");
  await key(textArea(node), "z", { ctrlKey: true }); expect(textArea(node).value).toBe("第一稿");
  await input(textArea(node), "新分支"); expect(editHandle.current!.canRedo).toBe(false);
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await input(textArea(node), "新分支中"); await input(textArea(node), "新分支中文");
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
  await key(textArea(node), "z", { ctrlKey: true }); expect(textArea(node).value).toBe("新分支");
  await key(textArea(node), "y", { ctrlKey: true }); expect(textArea(node).value).toBe("新分支中文");
});

it.each([
  ["错误项目", (state: ProjectDocuments) => { state.projectId = "other"; }],
  ["重复文档 ID", (state: ProjectDocuments) => { state.documents[1]!.id = state.documents[0]!.id; }],
  ["空文档 ID", (state: ProjectDocuments) => { state.documents[0]!.id = ""; }],
  ["空白文档 ID", (state: ProjectDocuments) => { state.documents[0]!.id = "   "; state.activeId = "   "; }],
  ["无效 activeId", (state: ProjectDocuments) => { state.activeId = "missing"; }],
  ["正文类型错误", (state: ProjectDocuments) => { (state.documents[0] as unknown as { content: number }).content = 3; }],
  ["空文档集", (state: ProjectDocuments) => { state.documents = []; state.activeId = ""; }],
] as const)("外部 revision 拒绝%s且不改正文、历史和磁盘 bytes", async (_label, mutate) => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const editHandle: { current: ScriptEditHandle | null } = { current: null };
  const { node, render } = await mount({ project: work, editHandle });
  await input(textArea(node), "已保存人工稿"); await click(button(node, "保存"));
  const raw = localStorage.getItem(projectDocumentsKey(work.id)), invalid = structuredClone(initial); mutate(invalid);
  await render({ revision: 1, externalState: invalid });
  expect(node.querySelector('[role="alert"]')).not.toBeNull(); expect(textArea(node).value).toBe("已保存人工稿");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw); expect(editHandle.current!.canUndo).toBe(true);
});

it("拒绝脏稿覆盖，保留磁盘旧 bytes；保存后旧 revision 不重新应用", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  await input(textArea(node), "未保存人工稿");
  const external = structuredClone(initial); external.documents[0]!.content = "外部恢复";
  const raw = localStorage.getItem(projectDocumentsKey(work.id));
  await render({ revision: 2, externalState: external });
  expect(textArea(node).value).toBe("未保存人工稿"); expect(node.querySelector('[role="alert"]')!.textContent).toContain("未保存修改");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
  await click(button(node, "保存"));
  await render({ externalState: structuredClone(external) });
  await render({ revision: 1, externalState: external });
  expect(textArea(node).value).toBe("未保存人工稿");
});

it("外部恢复读取当前磁盘 raw 为 baseline，正文保存后可以继续正常编辑保存", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  const disk = structuredClone(initial); disk.documents[0]!.content = "磁盘已由 Git 写入";
  const raw = JSON.stringify(disk, null, 2); localStorage.setItem(projectDocumentsKey(work.id), raw);
  const external = structuredClone(disk); external.documents[0]!.content = "外部合法恢复稿";
  await render({ revision: 1, externalState: external });
  expect(textArea(node).value).toBe("外部合法恢复稿"); expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
  await click(button(node, "保存")); expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(readProjectDocuments(work.id)).toEqual(external);
  await input(textArea(node), "恢复后继续编辑"); await click(button(node, "保存"));
  expect(readProjectDocuments(work.id).documents[0]!.content).toBe("恢复后继续编辑");
});

it("接受已经写入磁盘的 Git 恢复及合法新文档身份，后续自动保存不冲突", async () => {
  vi.useFakeTimers();
  try {
    const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
    const { node, render } = await mount({ project: work });
    const external = createProjectDocuments(work); external.activeId = external.documents[1]!.id;
    saveProjectDocuments(external); const raw = localStorage.getItem(projectDocumentsKey(work.id));
    await render({ revision: 1, externalState: external });
    expect(textArea(node).value).toBe(external.documents[1]!.content);
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
    await input(textArea(node), "恢复后自动保存"); await act(async () => { vi.advanceTimersByTime(650); });
    expect(node.querySelector('[role="alert"]')).toBeNull(); expect(readProjectDocuments(work.id).documents[1]!.content).toBe("恢复后自动保存");
  } finally { vi.useRealTimers(); }
});

it("相同外部版本不清 undo，父回送相同 revision 不重复应用或清历史", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const editHandle: { current: ScriptEditHandle | null } = { current: null };
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); dispose = () => act(() => root.unmount());
  let restore!: (value: ProjectDocuments) => void, snapshot!: ProjectDocuments;
  function Harness() {
    const [value, setValue] = useState(initial), [revision, setRevision] = useState(0);
    restore = value => { setValue(value); setRevision(item => item + 1); };
    return createElement(ScriptEditor, { project: work, externalState: value, revision, editHandle,
      onDocumentsChange: next => { snapshot = next; setValue(next); } });
  }
  await act(async () => root.render(createElement(Harness)));
  await input(textArea(div), "已保存改稿"); await click(button(div, "保存"));
  await act(async () => restore(structuredClone(snapshot)));
  expect(editHandle.current!.canUndo).toBe(true);
  await key(textArea(div), "z", { ctrlKey: true }); expect(textArea(div).value).toBe(initial.documents[0]!.content);
  expect(editHandle.current!.canRedo).toBe(true);
  await key(textArea(div), "y", { ctrlKey: true }); expect(textArea(div).value).toBe("已保存改稿");
});

it("IME 挂起外部快照且结束后自动应用，父回送不会替换待处理版本", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  const external = structuredClone(initial); external.documents[0]!.content = "组合结束后载入";
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await render({ revision: 1, externalState: external });
  await render({ externalState: structuredClone(initial) });
  expect(textArea(node).value).toBe(initial.documents[0]!.content);
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(textArea(node).value).toBe("组合结束后载入"); await click(button(node, "保存"));
  expect(readProjectDocuments(work.id).documents[0]!.content).toBe("组合结束后载入");
});

it("IME 结束后重新检查脏稿，不覆盖已输入中文及其 undo", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  const external = structuredClone(initial); external.documents[0]!.content = "不应覆盖的外部稿";
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await render({ revision: 1, externalState: external }); await input(textArea(node), "刚输入的中文");
  const raw = localStorage.getItem(projectDocumentsKey(work.id));
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(textArea(node).value).toBe("刚输入的中文"); expect(node.querySelector('[role="alert"]')!.textContent).toContain("未保存修改");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
  await key(textArea(node), "z", { ctrlKey: true }); expect(textArea(node).value).toBe(initial.documents[0]!.content);
});

it("相同的脏稿回送不接管其他窗口 baseline，后续保存仍拒绝覆盖", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const changed = vi.fn(), { node, render } = await mount({ project: work, onDocumentsChange: changed });
  await input(textArea(node), "本窗口未保存稿");
  const disk = structuredClone(initial); disk.documents[0]!.content = "另一窗口稿"; saveProjectDocuments(disk);
  const raw = localStorage.getItem(projectDocumentsKey(work.id));
  await render({ revision: 1, externalState: structuredClone(changed.mock.lastCall![0]) });
  await click(button(node, "保存"));
  expect(textArea(node).value).toBe("本窗口未保存稿"); expect(node.querySelector('[role="alert"]')!.textContent).toContain("其他窗口");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
});

it("IME 挂起时新 revision 替代旧快照，完成后只载入最新版本", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  const first = structuredClone(initial), latest = structuredClone(initial);
  first.documents[0]!.content = "旧外部稿"; latest.documents[0]!.content = "新外部稿";
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await render({ revision: 1, externalState: first }); await render({ revision: 2, externalState: latest });
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  expect(textArea(node).value).toBe("新外部稿");
});

it("相同版本已在磁盘保存时保留 undo 且不由旧自动保存计时器重写 bytes", async () => {
  vi.useFakeTimers();
  try {
    const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
    const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
    const { node, render } = await mount({ project: work, editHandle, onDocumentsChange: changed });
    await input(textArea(node), "外部确认保存的同一稿");
    const external = structuredClone(changed.mock.lastCall![0]), raw = JSON.stringify(external, null, 2);
    localStorage.setItem(projectDocumentsKey(work.id), raw);
    await render({ revision: 1, externalState: external });
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw); expect(editHandle.current!.canUndo).toBe(true);
    await input(textArea(node), "再次编辑"); await click(button(node, "保存"));
    expect(node.querySelector('[role="alert"]')).toBeNull(); expect(readProjectDocuments(work.id).documents[0]!.content).toBe("再次编辑");
  } finally { vi.useRealTimers(); }
});

it("外部恢复拒绝损坏磁盘，不把无效 raw 当作新 baseline", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const { node, render } = await mount({ project: work });
  localStorage.setItem(projectDocumentsKey(work.id), "{corrupt");
  const external = structuredClone(initial); external.documents[0]!.content = "外部稿";
  await render({ revision: 1, externalState: external });
  expect(textArea(node).value).toBe(initial.documents[0]!.content); expect(node.querySelector('[role="alert"]')!.textContent).toContain("损坏");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe("{corrupt");
});

it("恢复预检允许已确认脏稿且无副作用；accept 无 I/O、清历史并只接收一次", async () => {
  vi.useFakeTimers();
  try {
    const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
    const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn(), historyChanged = vi.fn();
    const { node, render } = await mount({ project: work, editHandle, onDocumentsChange: changed, onHistoryChange: historyChanged });
    await input(textArea(node), "Git 已备份的未保存草稿");
    const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments;
    const next = createProjectDocuments(work); next.activeId = next.documents[1]!.id; next.documents[1]!.content = "恢复后的大纲";
    const snapshot = structuredClone(next), raw = JSON.stringify(snapshot), oldRaw = localStorage.getItem(projectDocumentsKey(work.id));
    const changes = changed.mock.calls.length, selections = (node.querySelector("textarea") as HTMLTextAreaElement).value;
    let accept!: () => void;
    const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
    accept = editHandle.current!.prepareRestore!(next, expected);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(changes); expect(textArea(node).value).toBe(selections); expect(editHandle.current!.canUndo).toBe(true);
    get.mockRestore(); put.mockRestore(); expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(oldRaw);
    next.documents[1]!.content = "调用者后来修改，不得污染冻结快照";
    localStorage.setItem(projectDocumentsKey(work.id), raw);
    await act(async () => {
      const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
      accept(); accept();
      expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
      expect(editHandle.current!.canUndo).toBe(false); expect(editHandle.current!.canRedo).toBe(false);
      get.mockRestore(); put.mockRestore();
    });
    expect(changed).toHaveBeenCalledTimes(changes + 1); expect(changed.mock.lastCall![0]).toEqual(snapshot);
    expect(textArea(node).value).toBe("恢复后的大纲"); expect(textArea(node).selectionStart).toBe(0);
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
    await input(textArea(node), "接收后继续编辑"); await act(async () => accept());
    expect(textArea(node).value).toBe("接收后继续编辑"); expect(editHandle.current!.canUndo).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(readProjectDocuments(work.id).documents[1]!.content).toBe("接收后继续编辑");
    await render({ project: project() }); await render({ project: work });
    expect(textArea(node).value).toBe("接收后继续编辑"); expect(node.querySelector('[role="alert"]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("恢复预检拒绝 IME、DOM 未同步和完整 expected 过期，旧句柄卸载后失效", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { node, props, render } = await mount({ editHandle, onDocumentsChange: changed });
  const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments, next = createProjectDocuments(props.project);
  const handle = editHandle.current!, raw = localStorage.getItem(projectDocumentsKey(props.project.id)), calls = changed.mock.calls.length;
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(() => handle.prepareRestore!(next, expected)).toThrow(/完成中文输入/);
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  textArea(node).value = "尚未触发 input";
  expect(() => handle.prepareRestore!(next, expected)).toThrow(/不同步/);
  textArea(node).value = expected.documents[0]!.content;
  const stale = structuredClone(expected); stale.documents[1]!.title = "非当前文档也必须核对";
  expect(() => handle.prepareRestore!(next, stale)).toThrow(/过期/);
  const staleActive = { ...expected, activeId: expected.documents[1]!.id };
  expect(() => handle.prepareRestore!(next, staleActive)).toThrow(/过期/);
  expect(localStorage.getItem(projectDocumentsKey(props.project.id))).toBe(raw); expect(handle.canUndo).toBe(false);
  expect(changed.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  const accept = handle.prepareRestore!(next, expected);
  await render({ project: project() });
  expect(() => handle.prepareRestore!(next, expected)).toThrow(/已卸载/);
  const currentText = textArea(node).value; await act(async () => accept()); expect(textArea(node).value).toBe(currentText);
});

it.each([
  ["空文档", (value: ProjectDocuments) => { value.documents = []; value.activeId = ""; }],
  ["错误项目", (value: ProjectDocuments) => { value.projectId = "other"; }],
  ["错误 activeId", (value: ProjectDocuments) => { value.activeId = "missing"; }],
  ["重复文档", (value: ProjectDocuments) => { value.documents.push(value.documents[0]!); }],
] as const)("恢复预检拒绝%s且保留当前状态和磁盘", async (_label, mutate) => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { node, props } = await mount({ editHandle, onDocumentsChange: changed });
  const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments, next = structuredClone(expected); mutate(next);
  const value = textArea(node).value, raw = localStorage.getItem(projectDocumentsKey(props.project.id)), calls = changed.mock.calls.length;
  expect(() => editHandle.current!.prepareRestore!(next, expected)).toThrow();
  expect(textArea(node).value).toBe(value); expect(changed).toHaveBeenCalledTimes(calls);
  expect(editHandle.current!.canUndo).toBe(false); expect(localStorage.getItem(projectDocumentsKey(props.project.id))).toBe(raw);
});

it("accept 清除旧 pending draft，立即切项目再打开不会复活恢复前草稿", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const work = project(), { node, render } = await mount({ project: work, editHandle, onDocumentsChange: changed });
  await input(textArea(node), "恢复前尚未保存的缓存草稿");
  const next = createProjectDocuments(work); next.documents[0]!.content = "父级已经落盘的恢复稿";
  const accept = editHandle.current!.prepareRestore!(next, changed.mock.lastCall![0]);
  saveProjectDocuments(next); await act(async () => accept());
  await render({ project: project() }); await render({ project: work });
  expect(textArea(node).value).toBe("父级已经落盘的恢复稿"); expect(editHandle.current!.canUndo).toBe(false);
  expect(node.querySelector('[role="alert"]')).toBeNull();
});

it("空脚本恢复停用不渲染空 state、不做 I/O，批量卸载后草稿缓存不复活", async () => {
  vi.useFakeTimers();
  try {
    const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
    const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
    const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
    dispose = () => act(() => root.unmount());
    let visit!: (value: boolean) => void;
    function Harness() {
      const [visited, setVisited] = useState(true); visit = setVisited;
      return visited ? createElement(ScriptEditor, { project: work, editHandle, onDocumentsChange: changed }) : null;
    }
    await act(async () => root.render(createElement(Harness)));
    await input(textArea(node), "恢复空文档前的未保存脚本缓存");
    const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments, handle = editHandle.current!;
    const calls = changed.mock.calls.length, raw = localStorage.getItem(projectDocumentsKey(work.id));
    const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
    const deactivate = handle.prepareDeactivate!(expected);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(handle.canUndo).toBe(true); expect(changed).toHaveBeenCalledTimes(calls);
    expect(textArea(node).value).toBe("恢复空文档前的未保存脚本缓存"); get.mockRestore(); put.mockRestore();
    expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
    const empty: ProjectDocuments = { version: 1, projectId: work.id, documents: [], activeId: "" }, emptyRaw = JSON.stringify(empty);
    await act(async () => {
      localStorage.setItem(projectDocumentsKey(work.id), emptyRaw);
      const get = vi.spyOn(Storage.prototype, "getItem"), put = vi.spyOn(Storage.prototype, "setItem");
      deactivate(); deactivate();
      expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
      expect(handle.canUndo).toBe(false); expect(handle.canRedo).toBe(false);
      expect(textArea(node).value).toBe("恢复空文档前的未保存脚本缓存"); expect(changed).toHaveBeenCalledTimes(calls);
      get.mockRestore(); put.mockRestore(); visit(false);
    });
    expect(editHandle.current).toBeNull(); expect(node.querySelector("textarea")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(emptyRaw);
    await act(async () => visit(true));
    const fresh = changed.mock.lastCall![0] as ProjectDocuments;
    expect(fresh.documents.map(doc => doc.id)).not.toContain(expected.activeId);
    expect(textArea(node).value).toContain("原始旁白"); expect(textArea(node).value).not.toContain("未保存脚本缓存");
    expect(editHandle.current!.canUndo).toBe(false); expect(node.querySelector('[role="alert"]')).toBeNull();
    await input(textArea(node), "重新打开后新草稿"); await act(async () => deactivate());
    expect(textArea(node).value).toBe("重新打开后新草稿");
    await click(button(node, "保存")); expect(readProjectDocuments(work.id).documents[0]!.content).toBe("重新打开后新草稿");
  } finally { vi.useRealTimers(); }
});

it("脚本停用后旧自动保存计时器和手动保存均不回写旧稿或重新缓存", async () => {
  vi.useFakeTimers();
  try {
    const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
    const { node, props } = await mount({ editHandle, onDocumentsChange: changed });
    await input(textArea(node), "不得由旧计时器回写的脚本");
    const deactivate = editHandle.current!.prepareDeactivate!(changed.mock.lastCall![0]);
    const empty: ProjectDocuments = { version: 1, projectId: props.project.id, documents: [], activeId: "" }, raw = JSON.stringify(empty);
    localStorage.setItem(projectDocumentsKey(props.project.id), raw);
    const calls = changed.mock.calls.length;
    await act(async () => deactivate()); await click(button(node, "保存"));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem(projectDocumentsKey(props.project.id))).toBe(raw); expect(changed).toHaveBeenCalledTimes(calls);
    expect(textArea(node).value).toBe("不得由旧计时器回写的脚本");
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
    dispose(); node.remove(); const reopened = await mount({ project: props.project });
    expect(textArea(reopened.node).value).not.toContain("不得由旧计时器回写");
  } finally { vi.useRealTimers(); }
});

it("脚本停用复用恢复预检，拒绝 IME、DOM 不同步、过期 expected 和卸载句柄", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { node, props, render } = await mount({ editHandle, onDocumentsChange: changed });
  await input(textArea(node), "应保留的脚本草稿");
  const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments, handle = editHandle.current!;
  const work = props.project, raw = localStorage.getItem(projectDocumentsKey(work.id));
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(() => handle.prepareDeactivate!(expected)).toThrow(/完成中文输入/);
  expect(textArea(node).value).toBe("应保留的脚本草稿"); expect(handle.canUndo).toBe(true);
  await act(async () => textArea(node).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  textArea(node).value = "DOM 暂未同步"; expect(() => handle.prepareDeactivate!(expected)).toThrow(/不同步/); textArea(node).value = expected.documents[0]!.content;
  const stale = structuredClone(expected); stale.documents[1]!.title = "其他文档的过期标题";
  expect(() => handle.prepareDeactivate!(stale)).toThrow(/过期/);
  expect(localStorage.getItem(projectDocumentsKey(props.project.id))).toBe(raw);
  const deactivate = handle.prepareDeactivate!(expected);
  await render({ project: project() }); expect(() => handle.prepareDeactivate!(expected)).toThrow(/已卸载/);
  await act(async () => deactivate());
  await render({ project: work }); expect(textArea(node).value).toBe("应保留的脚本草稿");
});

it.each(["非空", "显式空"] as const)("未挂载脚本优先读取 pending 用于备份，成功恢复%s后定向清理不复活", async kind => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { node, render } = await mount({ project: work, editHandle, onDocumentsChange: changed });
  await input(textArea(node), "A 项目未落盘的待备份脚本");
  const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments;
  await render({ project: project() }); dispose(); node.remove(); dispose = () => {};
  expect(editHandle.current).toBeNull(); expect(readProjectDocuments(work.id)).toEqual(initial);
  const backup = readPendingScriptDocuments(work.id) ?? readProjectDocuments(work.id);
  expect(backup).toEqual(expected); backup.documents[0]!.content = "修改备份副本不得污染缓存";
  expect(readPendingScriptDocuments(work.id)).toEqual(expected);
  const next: ProjectDocuments = kind === "显式空" ? { version: 1, projectId: work.id, documents: [], activeId: "" } : createProjectDocuments(work);
  if (next.documents.length) next.documents[0]!.content = "Git 恢复的新脚本";
  saveProjectDocuments(next, undefined, JSON.stringify(initial)); clearPendingAuthoringDrafts(work.id, { script: true });
  expect(readPendingScriptDocuments(work.id)).toBeUndefined();
  const raw = localStorage.getItem(projectDocumentsKey(work.id)), reopened = await mount({ project: work });
  expect(textArea(reopened.node).value).not.toContain("待备份脚本");
  expect(textArea(reopened.node).value).toContain(kind === "显式空" ? "原始旁白" : "Git 恢复的新脚本");
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
});

it("未挂载脚本恢复写入失败保留 pending、raw 和错误，重新打开仍是完整草稿", async () => {
  const work = project(), initial = createProjectDocuments(work); saveProjectDocuments(initial);
  const changed = vi.fn(), { node, render } = await mount({ project: work, onDocumentsChange: changed });
  await input(textArea(node), "恢复失败必须保留的未落盘脚本");
  const expected = structuredClone(changed.mock.lastCall![0]) as ProjectDocuments;
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await click(button(node, "保存")); fail.mockRestore();
  const draft = pendingScriptDrafts.get(work.id)!; expect(draft.error).not.toBe("");
  await render({ project: project() }); dispose(); node.remove(); dispose = () => {};
  const raw = localStorage.getItem(projectDocumentsKey(work.id));
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => { saveProjectDocuments(createProjectDocuments(work), undefined, raw); clearPendingAuthoringDrafts(work.id, { script: true }); }).toThrow();
  write.mockRestore(); expect(pendingScriptDrafts.get(work.id)).toBe(draft); expect(readPendingScriptDocuments(work.id)).toEqual(expected);
  expect(localStorage.getItem(projectDocumentsKey(work.id))).toBe(raw);
  const reopened = await mount({ project: work }); expect(textArea(reopened.node).value).toBe("恢复失败必须保留的未落盘脚本");
  expect(reopened.node.querySelector('[role="alert"]')!.textContent).toContain(draft.error);
});

it("恢复 expected 按语义指纹比较，不依赖对象字段顺序", async () => {
  const editHandle: { current: ScriptEditHandle | null } = { current: null }, changed = vi.fn();
  const { props } = await mount({ editHandle, onDocumentsChange: changed });
  const state = changed.mock.lastCall![0] as ProjectDocuments;
  const expected = { activeId: state.activeId, documents: state.documents.map(doc => ({ content: doc.content, updatedAt: doc.updatedAt, kind: doc.kind, title: doc.title, id: doc.id })), projectId: state.projectId, version: state.version };
  expect(() => editHandle.current!.prepareRestore!(createProjectDocuments(props.project), expected)).not.toThrow();
});

it("autosaves after the debounce and cancels stale timers on project changes", async () => {
  vi.useFakeTimers();
  try {
    const { node, props } = await mount(); await input(textArea(node), "自动保存正文");
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(readProjectDocuments(props.project.id).documents[0]!.content).toBe("自动保存正文");
  } finally { vi.useRealTimers(); }
});
