// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseProject, type Scene } from "@glintai/scenescript";
import { ShotCanvas } from "./ShotCanvas";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });

const project = parseProject({
  schemaVersion: 1, id: "shot-canvas", title: "Shot", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 1000 },
    elements: [{ id: "price", kind: "text", text: "¥199", x: 0.5, y: 0.5 }],
  }],
});

async function mount(scene: Scene = project.scenes[0]!, onChange = (_next: Scene) => {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ShotCanvas, { project, scene, onChange })); });
  return container;
}

const buttonByText = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find(button => button.textContent?.includes(text))!;

describe("Shot canvas", () => {
  it("renders existing objects and adds a text object", async () => {
    const changes: Scene[] = [];
    const root = await mount(project.scenes[0]!, next => changes.push(next));
    expect(root.textContent).toContain("¥199");
    await act(async () => { buttonByText(root, "添加文字对象").click(); });
    const added = changes.at(-1)!.elements!.find(element => element.kind === "text" && element.text === "新文字");
    expect(added).toBeTruthy();
  });

  it("edits text through the property panel", async () => {
    const changes: Scene[] = [];
    const root = await mount(project.scenes[0]!, next => changes.push(next));
    const input = root.querySelector<HTMLInputElement>('input[aria-label="文字内容"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "¥299"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(changes.at(-1)!.elements![0]).toMatchObject({ text: "¥299" });
  });

  it("adds a keyframe at the current playhead", async () => {
    const changes: Scene[] = [];
    const root = await mount(project.scenes[0]!, next => changes.push(next));
    const playhead = root.querySelector<HTMLInputElement>('input[aria-label="播放头"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(playhead, "400"); playhead.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { buttonByText(root, "加 opacity 关键帧").click(); });
    const track = changes.at(-1)!.tracks?.find(item => item.property === "opacity");
    expect(track?.keyframes).toEqual([{ atMs: 400, value: 1 }]);
  });

  it("lists keyframe times and seeks to them", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 700, value: 0.8 }] }] };
    const root = await mount(scene);
    expect(root.textContent).toContain("0.70s");
    await act(async () => { buttonByText(root, "0.70s").click(); });
    expect(root.textContent).toContain("播放头 0.70s");
  });

  it("removes the selected object together with its tracks", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }] }] };
    const changes: Scene[] = [];
    const root = await mount(scene, next => changes.push(next));
    await act(async () => { buttonByText(root, "删除选中对象").click(); });
    const next = changes.at(-1)!;
    expect(next.elements).toEqual([]);
    expect(next.tracks).toEqual([]);
  });
});
