// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

it("rejects a path exceeding the editor project limit without losing its pending draft", async () => {
  // Let the default 1500ms stroke fit so this test actually reaches the size gate.
  const large = parseProject({ ...project, scenes: Array.from({ length: 10 }, (_, i) => ({ ...project.scenes[0], id: `scene-${i}`, narration: { text: "a", durationMs: 5000 }, notes: "n".repeat(9600) })) });
  expect(JSON.stringify(large).length).toBeLessThan(100000);
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container), changed = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ShotCanvas, { project: large, scene: large.scenes[0]!, onChange: changed })));
  const details = [...container.querySelectorAll("details")].find(item => item.textContent?.includes("手绘与逐笔动画"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="新路径数据"]')!, d = `M0 0 ${"L100.123 100.234 ".repeat(220)}`;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, d); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => buttonByText(container, "加入镜头").click());
  expect(changed).not.toHaveBeenCalled(); expect(container.textContent).toContain("100000 字符"); expect(textarea.value).toBe(d);
});

describe("Shot canvas", () => {
  it("previews morph frames but keeps target controls and prevents ambiguous dragging", async () => {
    const shape = { id: "box", kind: "rect", x: .2, y: .5, w: .2, h: .2, fill: "#ff0000" };
    const morph = parseProject({ ...project, scenes: [
      { ...project.scenes[0], elements: [shape] },
      { ...project.scenes[0], id: "two", transition: { in: "shape-morph", durationMs: 1000 }, elements: [{ ...shape, x: .8, fill: "#0000ff" }] },
    ] });
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container), changed = vi.fn();
    dispose = () => act(() => root.unmount());
    await act(async () => root.render(createElement(ShotCanvas, { project: morph, scene: morph.scenes[1]!, onChange: changed })));
    const object = () => container.querySelector<HTMLElement>('[aria-label="对象 box"]')!;
    const playhead = container.querySelector<HTMLInputElement>('[aria-label="播放头"]')!;
    const seek = async (time: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(playhead, time); playhead.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(object().style.left).toBe("20%");
    expect(container.querySelector<HTMLInputElement>('[aria-label="水平位置"]')!.value).toBe("80");
    await act(async () => object().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(container.textContent).toContain("形变预览期间不能拖动"); expect(changed).not.toHaveBeenCalled();
    await seek("500"); expect(object().style.left).toBe("50%"); expect(object().style.background).toBe("rgb(128, 0, 128)");
    await seek("1000"); expect(object().style.left).toBe("80%"); expect(container.textContent).not.toContain("正在预览形变");
  });
  it("edits path bounds with the existing project transaction and displays them on the canvas", async () => {
    const shape = { id: "line", kind: "path" as const, x: .5, y: .5, w: 1, h: 1, d: "M0 0 L90 90", viewBox: [100, 100] as [number, number], stroke: "#ffffff", strokeWidth: 4 };
    const initial = parseProject({ ...project, scenes: [{ ...project.scenes[0], elements: [shape] }] });
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    dispose = () => act(() => root.unmount()); let current = initial;
    function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(ShotCanvas, { project: value, scene: value.scenes[0]!, onChange: scene => setValue({ ...value, scenes: [scene] }) }); }
    await act(async () => root.render(createElement(Harness)));
    const change = async (label: string, value: string) => act(async () => {
      const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await change("路径宽度", "0.1"); await change("路径高度", "45.5");
    expect(current.scenes[0]!.elements![0]).toMatchObject({ w: .001, h: .455, d: shape.d, viewBox: shape.viewBox });
    expect(container.querySelector<SVGElement>('[aria-label="对象 line"]')!.style.width).toBe("0.1%");
    expect(container.querySelector<SVGElement>('[aria-label="对象 line"]')!.style.height).toBe("45.5%");
    expect(parseProject(current)).toEqual(current);
    await change("路径宽度", "100");
    expect(current.scenes[0]!.elements![0]).toMatchObject({ w: 1 });
    await act(async () => root.render(createElement(ShotCanvas, { project: current, scene: { ...current.scenes[0]!, locked: true }, onChange: vi.fn() })));
    expect(container.querySelector<HTMLInputElement>('[aria-label="路径宽度"]')!.matches(":disabled")).toBe(true);
  });

  it("preserves path drafts and rejects stale writes after another scene edit", async () => {
    const path = { id: "line", kind: "path" as const, x: .5, y: .5, w: 1, h: 1, d: "M0 0 L90 90", viewBox: [100, 100] as [number, number], stroke: "#ffffff", strokeWidth: 4 };
    const initial = parseProject({ ...project, scenes: [{ ...project.scenes[0], elements: [path] }] });
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    dispose = () => act(() => root.unmount()); let current = initial, update!: (value: typeof initial) => void;
    function Harness() { const [value, setValue] = useState(initial); current = value; update = setValue; return createElement(ShotCanvas, { project: value, scene: value.scenes[0]!, onChange: scene => setValue({ ...value, scenes: [scene] }) }); }
    await act(async () => root.render(createElement(Harness)));
    const field = () => container.querySelector<HTMLTextAreaElement>('[aria-label="选中路径数据"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field(), "M0 0 L20 20"); field().dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => update({ ...current, scenes: [{ ...current.scenes[0]!, elements: [{ ...path, d: "M0 0 L50 50" }] }] }));
    expect(field().value).toBe("M0 0 L20 20");
    expect(container.textContent).toContain("草稿已保留");
    expect(buttonByText(container, "应用路径数据").disabled).toBe(true);
    expect(current.scenes[0]!.elements![0]).toMatchObject({ d: "M0 0 L50 50" });
    await act(async () => buttonByText(container, "放弃路径草稿").click());
    expect(field().value).toBe("M0 0 L50 50");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

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
  it("edits shape geometry and animated properties against the current project", async () => {
    const scene: Scene = { ...project.scenes[0]!, elements: [{ id: "box", kind: "rect", x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: "#112233" }] };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    dispose = () => act(() => root.unmount()); let current = scene;
    function Harness() { const [value, setValue] = useState(scene); current = value; return createElement(ShotCanvas, { project, scene: value, onChange: setValue }); }
    await act(async () => root.render(createElement(Harness)));
    const change = async (label: string, value: string) => act(async () => {
      const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await change("色块宽度", "60"); await change("色块高度", "40"); await change("色块圆角", "24"); await change("色块颜色", "#ff0000");
    expect(current.elements?.[0]).toMatchObject({ w: 0.6, h: 0.4, radius: 24, fill: "#ff0000" });
    await change("对象缩放", "1.5"); await change("对象旋转", "45"); await change("透明度", "0.5");
    expect(current.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: "scale", keyframes: [{ atMs: 0, value: 1.5 }] }),
      expect.objectContaining({ property: "rotate", keyframes: [{ atMs: 0, value: 45 }] }),
      expect.objectContaining({ property: "opacity", keyframes: [{ atMs: 0, value: 0.5 }] }),
    ]));
    expect(container.querySelector<HTMLElement>('[aria-label="对象 box"]')!.style.transform).toContain("rotate(45deg) scale(1.5)");
  });
  it("edits one position keyframe without modifying the other axis", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [
      { elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }] },
      { elementId: "price", property: "y", keyframes: [{ atMs: 0, value: 0.3 }] },
    ] };
    const changes: Scene[] = [], container = await mount(scene, next => changes.push(next));
    const input = container.querySelector<HTMLInputElement>('[aria-label="水平位置"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "75"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(changes.at(-1)!.tracks?.[0]?.keyframes[0]?.value).toBe(0.75);
    expect(changes.at(-1)!.tracks?.[1]).toEqual(scene.tracks?.[1]);
  });
  it("adds a keyframe with the sampled value, rather than resetting the property", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] }] };
    const changes: Scene[] = [], container = await mount(scene, next => changes.push(next));
    const playhead = container.querySelector<HTMLInputElement>('[aria-label="播放头"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(playhead, "500"); playhead.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector<HTMLInputElement>('[aria-label="透明度"]')!.value).toBe("0.5");
    await act(async () => buttonByText(container, "加 opacity 关键帧").click());
    expect(changes.at(-1)!.tracks![0]!.keyframes[1]).toMatchObject({ atMs: 500, value: 0.5 });
  });
  it("exposes easing on the keyframe at the current playhead", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.8 }] }] };
    const changes: Scene[] = [], container = await mount(scene, next => changes.push(next));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="x 关键帧缓动"]')!;
    await act(async () => { select.value = "ease-in"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(changes.at(-1)!.tracks![0]!.keyframes[0]!.easing).toBe("ease-in");
  });
  it("moves a selected keyframe and reports collisions without changing the scene", async () => {
    const scene: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 33, value: 0.8, easing: "ease-in" }] }] };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    dispose = () => act(() => root.unmount()); let current = scene;
    function Harness() { const [value, setValue] = useState(scene); current = value; return createElement(ShotCanvas, { project, scene: value, onChange: setValue }); }
    await act(async () => root.render(createElement(Harness)));
    const forward = () => container.querySelector<HTMLButtonElement>('[aria-label="x 关键帧后移一帧"]')!;
    await act(async () => forward().click());
    expect(container.textContent).toContain("目标位置已有");
    expect(current.tracks![0]!.keyframes[0]!.atMs).toBe(0);
    await act(async () => buttonByText(container, "0.03s").click());
    await act(async () => forward().click());
    expect(current.tracks![0]!.keyframes[1]).toEqual({ atMs: 67, value: 0.8, easing: "ease-in" });
    expect(container.textContent).toContain("关键帧已移动至 0.067 秒");
    expect(container.querySelector<HTMLInputElement>('[aria-label="播放头"]')!.value).toBe("67");
  });
  it("moves an exact keyframe time, preserves easing, and rejects invalid or stale drafts", async () => {
    const initial: Scene = { ...project.scenes[0]!, tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2, easing: "ease-in" }, { atMs: 700, value: 0.8 }] }] };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    dispose = () => act(() => root.unmount()); let current = initial, update!: (scene: Scene) => void;
    function Harness() { const [value, setValue] = useState(initial); current = value; update = setValue; return createElement(ShotCanvas, { project: { ...project, scenes: [value] }, scene: value, onChange: setValue }); }
    await act(async () => root.render(createElement(Harness)));
    const field = () => container.querySelector<HTMLInputElement>('[aria-label="x 关键帧时间"]')!;
    const edit = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value); field().dispatchEvent(new Event("input", { bubbles: true })); });
    const submit = async () => act(async () => field().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await edit("700"); await submit(); expect(container.textContent).toContain("目标位置已有"); expect(current).toEqual(initial);
    await edit(""); await submit(); expect(container.textContent).toContain("整数毫秒"); expect(current).toEqual(initial);
    await edit("1001"); await submit(); expect(container.textContent).toContain("整数毫秒"); expect(current).toEqual(initial);
    await edit("125"); await submit();
    expect(current.tracks![0]!.keyframes).toEqual([{ atMs: 125, value: 0.2, easing: "ease-in" }, { atMs: 700, value: 0.8 }]);
    expect(container.textContent).toContain("0.125 秒");
    await edit("250"); await act(async () => update({ ...current, notes: "其他编辑" })); await submit();
    expect(container.textContent).toContain("镜头在编辑时间期间已变化"); expect(current.tracks![0]!.keyframes[0]!.atMs).toBe(125);
  });

  it("does not expose frame movement for executable scene kinds", async () => {
    const base = { elements: [{ id: "price", kind: "text", text: "x" }], tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }] }] };
    for (const kind of ["html", "three"] as const) {
      const scene = { ...project.scenes[0]!, ...base, kind } as Scene;
      const container = await mount(scene);
      expect(container.querySelector('[aria-label="x 关键帧后移一帧"]')).toBeNull();
      dispose(); document.body.innerHTML = ""; dispose = () => {};
    }
  });
  it("disables object modification on locked scenes", async () => {
    const changes: Scene[] = [], container = await mount({ ...project.scenes[0]!, locked: true }, next => changes.push(next));
    expect(buttonByText(container, "添加文字对象").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="对象缩放"]')!.closest("fieldset")!.disabled).toBe(true);
    expect(changes).toHaveLength(0);
  });
  it("resets selection, playhead and draft when switching scenes", async () => {
    const scene2: Scene = { ...project.scenes[0]!, id: "two", elements: [{ id: "new", kind: "text", text: "第二镜" }] };
    const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); dispose = () => act(() => root.unmount());
    await act(async () => root.render(createElement(ShotCanvas, { project, scene: project.scenes[0]!, onChange: () => {} })));
    const first = div.querySelector<HTMLInputElement>('[aria-label="文字内容"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(first, "旧草稿"); first.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => root.render(createElement(ShotCanvas, { project, scene: scene2, onChange: () => {} })));
    expect(div.querySelector<HTMLInputElement>('[aria-label="文字内容"]')!.value).toBe("第二镜");
    expect(div.textContent).not.toContain("旧草稿");
  });
  it("discards a drag if the scene changed before pointer release", async () => {
    const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), changes: Scene[] = [];
    dispose = () => act(() => root.unmount());
    const render = async (scene: Scene) => act(async () => root.render(createElement(ShotCanvas, { project, scene, onChange: next => changes.push(next) })));
    await render(project.scenes[0]!);
    const canvas = div.querySelector<HTMLElement>('[aria-label="镜头画布"]')!;
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) });
    await act(async () => div.querySelector<HTMLElement>('[aria-label="对象 price"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 })));
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 10 })));
    await render({ ...project.scenes[0]!, narration: { text: "远端修改", durationMs: 1000 } });
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(changes).toHaveLength(0); expect(div.textContent).toContain("拖动期间已变化");
  });
});
