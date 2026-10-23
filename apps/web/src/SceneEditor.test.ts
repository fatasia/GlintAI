// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { SceneEditor } from "./SceneEditor";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

const project = parseProject({
  schemaVersion: 1, id: "scene-editor", title: "Editor", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 },
    elements: [{ id: "price", kind: "text", text: "¥199", x: 0.5, y: 0.5 }],
  }],
});

it("mounts the shot canvas inside the scene editor", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(SceneEditor, { project, onChange: () => {} })); });
  for (let attempt = 0; attempt < 200 && !div.querySelector('[aria-label="风格包"]'); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(div.textContent).toContain("对象与关键帧");
  expect(div.textContent).toContain("¥199");
  expect(div.textContent).toContain("添加文字对象");
  expect(div.querySelector('[aria-label="场景剪辑"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="画面风格"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="风格包"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="为这个镜头生成素材"]')).not.toBeNull();
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
it("keeps one workbench: creative view shows the canvas beside a shared preview panel", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SceneEditor, { project, onChange: () => {} })));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  await click("创意");
  expect(div.querySelector('[aria-label="创意工作区"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="画布预览"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="作品工作区"]')).toBeNull();
  await click("作品");
  expect(div.querySelector('[aria-label="作品工作区"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="创意工作区"]')).toBeNull();
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
