// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { SceneEditor } from "./SceneEditor";
import { ArtifactChat } from "./ArtifactChat";
import { createProjectDocuments } from "./script-documents";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const project = parseProject({
  schemaVersion: 1, id: "scene-editor", title: "Editor", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 },
    elements: [{ id: "price", kind: "text", text: "¥199", x: 0.5, y: 0.5 }],
  }],
});

it("isolates container documents from local Git and auxiliary document writes", async () => {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  localStorage.setItem(`glint:git-restore.v1:${project.id}`, "broken");
  const write = vi.spyOn(Storage.prototype, "setItem");
  try {
    await act(async () => root.render(createElement(SceneEditor, { project, documentOnly: true, onChange: () => {}, history: { undoDepth: 0, redoDepth: 0, undo: () => {}, redo: () => {} } })));
    for (const label of ["创意", "脚本", "分镜", "设计", "保存版本", "Git 改动与历史…"]) {
      const button = [...div.querySelectorAll("button")].find(item => item.textContent === label)!;
      expect(button, label).toBeTruthy(); expect(button.disabled, label).toBe(true);
    }
    expect(div.textContent).not.toContain("恢复日志损坏");
    expect(div.querySelector('[aria-label="title"]')).not.toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(`glint:git-restore.v1:${project.id}`)).toBe("broken");
  } finally { localStorage.removeItem(`glint:git-restore.v1:${project.id}`); }
});

it("loads the shot canvas on visual intent and keeps it mounted across tabs", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(SceneEditor, { project, onChange: () => {} })); });
  expect(div.querySelector('[aria-label="对象与关键帧"]')).toBeNull();
  await act(async () => [...div.querySelectorAll('[role="tab"]')].find(button => button.textContent === "画面")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  for (let attempt = 0; attempt < 200 && (!div.querySelector('[aria-label="风格包"]') || !div.querySelector('[aria-label="对象与关键帧"]') || !div.querySelector('[aria-label="为这个镜头生成素材"]')); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(div.textContent).toContain("对象与关键帧");
  expect(div.textContent).toContain("¥199");
  expect(div.textContent).toContain("添加文字对象");
  expect(div.querySelector('[aria-label="场景剪辑"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="画面风格"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="风格包"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="为这个镜头生成素材"]')).not.toBeNull();
  const canvas = div.querySelector('[aria-label="对象与关键帧"]');
  await act(async () => [...div.querySelectorAll('[role="tab"]')].find(button => button.textContent === "内容")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(div.querySelector('[aria-label="对象与关键帧"]')).toBe(canvas);
});

it("edits and undoes product framing and camera in an existing image scene", async () => {
  const initial = parseProject({ ...project, scenes: [{ id: "photo", kind: "image", src: "assets/photo.png", caption: "产品", narration: { text: "介绍", durationMs: 2000 } }] });
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = initial;
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(SceneEditor, { project: value, onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  const layout = div.querySelector<HTMLSelectElement>('[aria-label="图片构图"]')!;
  await act(async () => { layout.value = "showcase"; layout.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(current.scenes[0]).toMatchObject({ presentation: "showcase" });
  const camera = div.querySelector<HTMLSelectElement>('[aria-label="图片镜头运动"]')!;
  await act(async () => { camera.value = "push"; camera.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(current.scenes[0]).toMatchObject({ presentation: "showcase", camera: { type: "push", intensity: 0.4 } });
  await act(async () => { camera.value = "pan-left"; camera.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(current.scenes[0]).toMatchObject({ camera: { type: "pan-left", intensity: 0.4 } });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "撤销")!.click());
  expect(current.scenes[0]).toMatchObject({ camera: { type: "push", intensity: 0.4 } });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "撤销")!.click());
  expect(current.scenes[0]).toMatchObject({ presentation: "showcase" });
  expect(current.scenes[0]!.camera).toBeUndefined();
});


it("routes timeline edits through editor undo and redo rather than a separate history", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = project;
  function Harness() {
    const [value, setValue] = useState(project); current = value;
    return createElement(SceneEditor, { project: value, onChange: setValue });
  }
  await act(async () => root.render(createElement(Harness)));
  const click = async (text: string) => {
    await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  };
  await click("末尾 −100 毫秒");
  expect(current.scenes[0]!.narration.durationMs).toBe(400);
  await click("撤销"); expect(current.scenes[0]!.narration.durationMs).toBe(500);
  await click("重做"); expect(current.scenes[0]!.narration.durationMs).toBe(400);
});
it("enables storyboard history only when its actual shared history channel is ready", async () => {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  const undo = vi.fn(), redo = vi.fn(); let shared = { undoDepth: 0, redoDepth: 0, undo, redo };
  function Harness() {
    const [value, setValue] = useState(project);
    return createElement(SceneEditor, { project: value, onChange: setValue, history: shared });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "末尾 −100 毫秒")!.click());
  await act(async () => [...div.querySelectorAll(".glint-view-switch button")].find(button => button.textContent === "分镜")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const undoButton = div.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')!;
  expect(undoButton.disabled).toBe(true);
  await act(async () => undoButton.click()); expect(undo).not.toHaveBeenCalled();
  shared = { ...shared, undoDepth: 1 };
  await act(async () => root.render(createElement(Harness)));
  expect(undoButton.disabled).toBe(false);
  await act(async () => undoButton.click()); expect(undo).toHaveBeenCalledOnce();
  shared = { ...shared, undoDepth: 0, redoDepth: 1 };
  await act(async () => root.render(createElement(Harness)));
  expect(undoButton.disabled).toBe(true);
  const redoButton = div.querySelector<HTMLButtonElement>('button[aria-label="重做"]')!;
  expect(redoButton.disabled).toBe(false);
  await act(async () => redoButton.click()); expect(redo).toHaveBeenCalledOnce();
});
it("routes a shape morph through the existing undo and redo history", async () => {
  const rect = { id: "box", kind: "rect", x: .3, y: .4, w: .2, h: .2, fill: "#ff0000" };
  const initial = parseProject({ ...project, scenes: [
    { ...project.scenes[0], elements: [rect] },
    { ...project.scenes[0], id: "two", elements: [{ ...rect, x: .7, fill: "#0000ff" }] },
  ] });
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = initial;
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(SceneEditor, { project: value, onChange: setValue, selection: ["two"] }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "应用形变")!.click());
  expect(current.scenes[1]!.transition).toMatchObject({ in: "shape-morph" });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "撤销")!.click());
  expect(current.scenes[1]!.transition).toBeUndefined();
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "重做")!.click());
  expect(current.scenes[1]!.transition).toMatchObject({ in: "shape-morph" });
});

it("routes a path morph through the existing undo and redo history", async () => {
  const path = { id: "line", kind: "path", x: .5, y: .5, w: 1, h: 1, d: "M0 0 L80 80", viewBox: [100, 100], stroke: "#ff0000", strokeWidth: 4 };
  const initial = parseProject({ ...project, scenes: [{ ...project.scenes[0], elements: [path] }, { ...project.scenes[0], id: "two", elements: [{ ...path, d: "M10 10 L90 90" }] }] });
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = initial;
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(SceneEditor, { project: value, onChange: setValue, selection: ["two"] }); }
  await act(async () => root.render(createElement(Harness)));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  await click("应用形变"); expect(current.scenes[1]!.transition?.in).toBe("shape-morph");
  await click("撤销"); expect(current.scenes[1]!.transition).toBeUndefined();
  await click("重做"); expect(current.scenes[1]!.transition?.in).toBe("shape-morph");
});

it("undoes a local filter preset through the same editor history", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = project;
  function Harness() {
    const [value, setValue] = useState(project); current = value;
    return createElement(SceneEditor, { project: value, onChange: setValue });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "黑白")!.click());
  expect(current.scenes[0]!.effects?.[0]).toMatchObject({ kind: "grayscale", value: 1 });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "撤销")!.click());
  expect(current.scenes[0]!.effects).toBeUndefined();
});
it("keeps one workbench: creative view keeps the project canvas unobstructed by a preview overlay", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project, onChange: () => {} })));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  await click("创意");
  expect(div.querySelector('[aria-label="创意工作区"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="画布预览"]')).toBeNull();
  expect(div.querySelector('[aria-label="作品工作区"]')!.closest('[hidden]')).not.toBeNull();
  await click("作品");
  expect(div.querySelector('[aria-label="作品工作区"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="创意工作区"]')!.closest('[hidden]')).not.toBeNull();
});
it("shows real library thumbnails in the shot strip for media scenes only", async () => {
  const media = parseProject({
    schemaVersion: 1, id: "media", title: "Media", aspect: "16:9", knowledgeSources: [],
    scenes: [
      { id: "pic", kind: "image", src: "assets/photo.png", narration: { text: "图", durationMs: 1000 } },
      { id: "clip", kind: "video", src: "assets/clip.mp4", narration: { text: "视频", durationMs: 1000 } },
      { id: "text", kind: "title", title: "纯文字", narration: { text: "文字", durationMs: 1000 } },
    ],
  });
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: media, onChange: () => {} })));
  const strip = div.querySelector('[aria-label="分镜时间线"]')!;
  expect(strip.querySelector('img')?.getAttribute("src")).toBe("/api/media/assets/photo.png");
  expect(strip.querySelector("video")?.getAttribute("src")).toBe("/api/media/assets/clip.mp4");
  expect(strip.querySelectorAll("img, video").length).toBeGreaterThanOrEqual(2);
});
it("does not let legacy move/delete buttons bypass timeline locks", async () => {
  const locked = { ...project, scenes: [project.scenes[0]!, { ...project.scenes[0]!, id: "two", locked: true }] };
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: locked, onChange: () => { throw new Error("Lock bypass"); } })));
  for (const text of ["上移", "下移", "删除分镜"]) {
    expect([...div.querySelectorAll("button")].find(button => button.textContent === text)?.disabled).toBe(true);
  }
});it("duplicates a scene and reorders by dragging the shot strip", async () => {
  const three = parseProject({ schemaVersion: 1, id: "order", title: "Order", aspect: "16:9", knowledgeSources: [], scenes: ["a", "b", "c"].map(id => ({ id, kind: "title", title: id, narration: { text: id, durationMs: 1000 } })) });
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = three;
  function Harness() { const [value, setValue] = useState(three); current = value; return createElement(SceneEditor, { project: value, onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  const tabs = [...div.querySelectorAll('[aria-label="分镜时间线"] [role="tab"]')];
  await act(async () => { tabs[0]!.dispatchEvent(new Event("dragstart", { bubbles: true })); });
  await act(async () => { tabs[2]!.dispatchEvent(new Event("drop", { bubbles: true })); });
  expect(current.scenes.map(scene => scene.id)).toEqual(["b", "c", "a"]);
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "复制分镜")!.click(); });
  expect(current.scenes).toHaveLength(4);
  expect(current.scenes.filter(scene => scene.narration.text === "a")).toHaveLength(2);
  expect(new Set(current.scenes.map(scene => scene.id)).size).toBe(4);
});
it("shows a three-pane studio and restores named versions", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = project;
  function Harness() { const [value, setValue] = useState(project); current = value; return createElement(SceneEditor, { project: value, onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  expect(div.querySelector('[aria-label="镜头栏"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="舞台"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="镜头属性"]')).not.toBeNull();
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text))!.click());
  await click("保存版本");
  await click("添加图表（示例数据）");
  expect(current.scenes).toHaveLength(2);
  await click("版本 1");
  expect(current.scenes).toHaveLength(1);
});

it("exposes J/L narration offset and per-scene SFX through the audio panel", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = project;
  function Harness() {
    const [value, setValue] = useState(project); current = value;
    return createElement(SceneEditor, { project: value, onChange: setValue });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "声音")!.click());
  const offset = div.querySelector<HTMLInputElement>('[aria-label="旁白偏移"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(offset, "-300");
    offset.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(current.scenes[0]!.narration.audioOffsetMs).toBe(-300);
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "添加音效")!.click());
  expect(current.sfx).toEqual([{ sceneId: "one", effect: "whoosh", gain: 0.35 }]);
  const gain = div.querySelector<HTMLInputElement>('[aria-label="音效 1 音量"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gain, "0.6");
    gain.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(current.sfx?.[0]?.gain).toBe(0.6);
  await act(async () => div.querySelector<HTMLButtonElement>('[aria-label="删除音效 1"]')!.click());
  expect(current.sfx).toEqual([]);
});


const scriptBody = (node: ParentNode) => node.querySelector<HTMLTextAreaElement>('[aria-label="脚本文档正文"]')!;
async function editText(node: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function visibleAssistant(node: ParentNode) {
  return [...node.querySelectorAll<HTMLElement>('[aria-label="文档创作助手"]')].find(item => !item.closest('[hidden]'))!;
}
async function sceneClick(node: ParentNode, text: string) {
  await act(async () => { [...node.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!.click(); });
}
async function openScript(node: ParentNode) {
  await sceneClick(node, "脚本");
  for (let i = 0; i < 100 && !scriptBody(node); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(scriptBody(node)).not.toBeNull();
}
it("脚本 AI 在切视图及切文档后继续生成，保留草稿并由顶部一次撤销整提案", async () => {
  let finish!: (response: Response) => void, signal!: AbortSignal, base: any;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === "/api/artifact/proposal") {
      base = JSON.parse(init.body).document; signal = init.signal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return Response.json({});
  }));
  const initial = { ...project, id: `continuity-${crypto.randomUUID()}` }, onChange = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: initial, onChange })));
  await openScript(div); const body = scriptBody(div); await editText(body, "人工草稿");
  const assistant = visibleAssistant(div);
  await editText(assistant.querySelector('textarea')!, "重写全文");
  await act(async () => assistant.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const picker = div.querySelector<HTMLSelectElement>('[aria-label="切换脚本文档"]')!, first = picker.value;
  await act(async () => { picker.value = picker.options[1]!.value; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  const other = visibleAssistant(div); await editText(other.querySelector('textarea')!, "另一文档草稿");
  await sceneClick(div, "作品"); expect(signal.aborted).toBe(false);
  await act(async () => { finish(Response.json({ document: { ...base, title: "新标题", content: "AI 第一段\nAI 第二段" }, summary: "已改写全文" })); });
  expect(signal.aborted).toBe(false); expect(assistant.textContent).toContain("已改写全文");
  await sceneClick(div, "脚本"); expect(visibleAssistant(div)).toBe(other); expect(other.querySelector('textarea')!.value).toBe("另一文档草稿");
  await act(async () => { picker.value = first; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(scriptBody(div).value).toBe("人工草稿"); expect(visibleAssistant(div)).toBe(assistant);
  await sceneClick(assistant, "确认应用"); expect(scriptBody(div).value).toBe("AI 第一段\nAI 第二段");
  const appliedBody = scriptBody(div);
  await sceneClick(div, "作品"); await sceneClick(div, "脚本"); expect(scriptBody(div)).toBe(appliedBody);
  await sceneClick(div, "撤销"); expect(scriptBody(div).value).toBe("人工草稿"); expect(picker.selectedOptions[0]!.text).not.toContain("新标题");
  await sceneClick(div, "重做"); expect(scriptBody(div).value).toBe("AI 第一段\nAI 第二段"); expect(onChange).not.toHaveBeenCalled();
});
it("IME 中确认提案传播 false，不报告假成功；过期预览不覆盖新稿", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => url === "/api/artifact/proposal"
    ? Response.json({ document: { ...JSON.parse(init.body).document, content: "AI 稿件" }, summary: "改稿" }) : Response.json({})));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: { ...project, id: `ime-${crypto.randomUUID()}` }, onChange: vi.fn() })));
  await openScript(div); await editText(scriptBody(div), "原稿"); const assistant = visibleAssistant(div);
  const generate = async () => {
    await editText(assistant.querySelector('textarea')!, "改写");
    await act(async () => assistant.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  await generate(); await act(async () => scriptBody(div).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await sceneClick(assistant, "确认应用"); expect(scriptBody(div).value).toBe("原稿"); expect(assistant.querySelector('[role="alert"]')!.textContent).toContain("未接受");
  expect(assistant.querySelector('[aria-label="本文档对话记录"]')!.textContent).not.toContain("提案已作为一次修改应用");
  await act(async () => scriptBody(div).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await generate(); await editText(scriptBody(div), "新人工稿"); await sceneClick(assistant, "确认应用");
  expect(scriptBody(div).value).toBe("新人工稿"); expect(assistant.querySelector('[role="alert"]')!.textContent).toContain("失效");
});
it("文档助手原样传播应用异常，不写入成功记录", async () => {
  const initial = { ...project, id: `apply-error-${crypto.randomUUID()}` }, doc = createProjectDocuments(initial).documents[0]!;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => Response.json({ document: { ...JSON.parse(init.body).document, content: "新稿" }, summary: "改写" })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  const onApply = vi.fn(() => { throw new Error("编辑历史拒绝应用"); });
  await act(async () => root.render(createElement(ArtifactChat, { projectId: initial.id, title: initial.title, document: doc, onApply })));
  await editText(div.querySelector('textarea')!, "改写");
  await act(async () => div.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await sceneClick(div, "确认应用");
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(div.querySelector('[role="alert"]')!.textContent).toBe("编辑历史拒绝应用");
  expect(div.querySelector('[aria-label="本文档对话记录"]')!.textContent).not.toContain("提案已作为一次修改应用");
});

it("设计源码与助手在切脚本后保留挂载和未提交草稿", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: { ...project, id: `design-continuity-${crypto.randomUUID()}` }, onChange: vi.fn() })));
  await sceneClick(div, "设计");
  for (let i = 0; i < 100 && !div.querySelector('[aria-label="设计文档编辑器"]'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await sceneClick(div, "HTML 源码");
  const source = div.querySelector<HTMLTextAreaElement>('[aria-label="页面 HTML 源码"]')!;
  await editText(source, '<main data-design-id="draft">设计草稿</main>');
  const assistant = visibleAssistant(div); await editText(assistant.querySelector('textarea')!, "未发送设计指令");
  const title = div.querySelector<HTMLInputElement>('[aria-label="设计文档标题"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "尚未提交标题");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await openScript(div);
  expect(source.closest('[hidden]')).not.toBeNull(); expect(assistant.closest('[hidden]')).not.toBeNull();
  await sceneClick(div, "设计");
  expect(div.querySelector('[aria-label="页面 HTML 源码"]')).toBe(source);
  expect(source.value).toContain("设计草稿"); expect(title.value).toBe("尚未提交标题");
  expect(visibleAssistant(div)).toBe(assistant); expect(assistant.querySelector('textarea')!.value).toBe("未发送设计指令");
});

it("画布素材任务切脚本时不清理，作品助手任务和输入草稿保留", async () => {
  let finishLibrary!: (response: Response) => void, librarySignal!: AbortSignal;
  let finishEdit!: (response: Response) => void, editSignal!: AbortSignal;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === "/api/media/library" && init?.signal) {
      librarySignal = init.signal;
      return new Promise<Response>(resolve => { finishLibrary = resolve; });
    }
    if (url === "/api/edit-scene") {
      editSignal = init.signal;
      return new Promise<Response>(resolve => { finishEdit = resolve; });
    }
    return Response.json({});
  }));
  const initial = { ...project, id: `canvas-continuity-${crypto.randomUUID()}` }, onChange = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project: initial, onChange })));
  const instruction = div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!;
  const setInstruction = async (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instruction, text);
    instruction.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await setInstruction("改标题"); await sceneClick(div, "AI 修改本分镜");
  await setInstruction("下一轮未发送草稿");
  await sceneClick(div, "创意");
  for (let i = 0; i < 100 && !div.querySelector('[aria-label="显示素材"]'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const board = div.querySelector('[aria-label="镜头画布"]')!;
  expect(board).not.toBeNull();
  await act(async () => div.querySelector<HTMLButtonElement>('[aria-label="显示素材"]')!.click());
  await openScript(div);
  expect(librarySignal.aborted).toBe(false); expect(editSignal.aborted).toBe(false);
  expect(div.querySelector('[aria-label="画布预览"]')).toBeNull();
  await act(async () => {
    finishLibrary(Response.json({ assets: [] }));
    finishEdit(Response.json({ project: { ...initial, scenes: [{ ...initial.scenes[0], title: "任务完成" }] } }));
  });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scenes: [expect.objectContaining({ title: "任务完成" })] }), "product-agent");
  await sceneClick(div, "创意"); expect(div.querySelector('[aria-label="镜头画布"]')).toBe(board);
  expect(board.textContent).toContain("素材库暂无");
  await sceneClick(div, "作品"); expect(div.querySelector('[aria-label="分镜修改指令"]')).toBe(instruction);
  expect(instruction.value).toBe("下一轮未发送草稿");
  expect(div.querySelector('[aria-label="本工程修改记录"]')!.textContent).toContain("这一镜已修改");
});

it("项目切换中止旧任务且隔离历史、文档与助手草稿", async () => {
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === "/api/artifact/proposal") { signal = init.signal; return new Promise<Response>(() => {}); }
    return Response.json({});
  }));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  const first = { ...project, id: `isolation-a-${crypto.randomUUID()}` }, second = { ...project, id: `isolation-b-${crypto.randomUUID()}` };
  const render = async (value: typeof project) => act(async () => root.render(createElement(SceneEditor, { project: value, onChange: vi.fn() })));
  await render(first); await openScript(div); await editText(scriptBody(div), "项目一未保存草稿"); const assistant = visibleAssistant(div);
  await editText(assistant.querySelector('textarea')!, "生成旧项目");
  await act(async () => assistant.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await render(second); expect(signal.aborted).toBe(true); await openScript(div);
  expect(scriptBody(div).value).not.toContain("项目一未保存草稿"); expect(visibleAssistant(div).querySelector('textarea')!.value).toBe("");
  expect(div.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true);
  await render(first); await openScript(div); expect(scriptBody(div).value).toBe("项目一未保存草稿");
});

it("routes the product approval action to the product callback", async () => {
  const initial = parseProject({ ...project, assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] }] });
  let releaseLibrary!: () => void;
  const libraryReady = new Promise<void>(resolve => { releaseLibrary = resolve; });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await libraryReady;
    return Response.json({ assets: [{ name: "item.png" }] });
  });
  const approve = vi.fn(async () => true), character = vi.fn(async () => true);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => { act(() => root.unmount()); fetcher.mockRestore(); };
  await act(async () => root.render(createElement(SceneEditor, { project: initial, onChange: () => {}, onApproveProduct: approve, canApproveProduct: true, onApproveCharacter: character, canApproveCharacter: true })));
  for (let i = 0; i < 100 && !div.querySelector('[aria-label="商品资产"]'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const panel = div.querySelector<HTMLDetailsElement>('[aria-label="商品资产"]')!;
  await act(async () => { panel.open = true; panel.dispatchEvent(new Event("toggle")); });
  const select = panel.querySelector<HTMLSelectElement>('[aria-label="选择商品资产"]')!;
  await act(async () => { select.value = "item"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const button = [...panel.querySelectorAll("button")].find(item => item.textContent === "批准商品版本")!;
  expect(button.disabled).toBe(true);
  await act(async () => { button.click(); releaseLibrary(); });
  expect(approve).not.toHaveBeenCalled();
  for (let i = 0; i < 100 && button.disabled; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(fetcher).toHaveBeenCalledWith("/api/media/library", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(button.disabled).toBe(false); await act(async () => button.click());
  expect(approve).toHaveBeenCalledWith("item"); expect(character).not.toHaveBeenCalled();
});
it("only offers shot properties in the shot editor, preserving their state on return", async () => {
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({assets:[]})));
 const div=document.createElement("div");document.body.appendChild(div);const root=createRoot(div);cleanup=()=>act(()=>root.unmount());
 await act(async()=>root.render(createElement(SceneEditor,{project,onChange:()=>{}})));
 const selector='button[aria-controls="glint-inspector"]';
 await act(async()=>div.querySelector<HTMLButtonElement>(selector)!.click());
 expect(div.querySelector(selector)!.getAttribute("aria-expanded")).toBe("true");
 await sceneClick(div,"创意");expect(div.querySelector(selector)).toBeNull();
 await sceneClick(div,"作品");expect(div.querySelector(selector)!.getAttribute("aria-expanded")).toBe("true");
});
