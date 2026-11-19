// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NleClip } from "@glintai/scenescript";
import { NleMotionEditor, type NleMotionEditorProps } from "./NleMotionEditor";

let host: HTMLDivElement, root: Root, props: NleMotionEditorProps;
const base = (): NleClip => ({ id: "motion-ui", kind: "text", text: "这是一个用于验证窄屏换行的很长的中文片段名称".repeat(12), startMs: 3000, durationMs: 2000, color: "#ffffff", keyframes: [{ ms: 0, x: -0.5, y: 0, rotate: 20, ease: "out" }, { ms: 1000, x: 0.5, y: 0.5, opacity: 0.4 }] });
const render = async (patch: Partial<NleMotionEditorProps> = {}) => { props = { ...props, ...patch }; await act(async () => root.render(createElement(NleMotionEditor, props))); };
const button = (text: string) => [...host.querySelectorAll("button")].find(element => element.textContent === text)!;
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`)!;
const click = async (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const key = async (element: Element, value: string) => act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });
const pointer = async (element: Element, type: string, x: number, y: number, at = 10) => act(async () => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, timeStamp: { value: at } }); element.dispatchEvent(event);
});
const rect = (element: Element) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 180, width: 300, height: 180, toJSON: () => ({}) });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { clip: base(), fps: 30, playheadMs: 3500, onChange: vi.fn(), onSeek: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

it("adds at clip-local playhead time, seeks project time, changes native easing, and deletes", async () => {
  await render(); await click(button("添加当前帧"));
  expect(props.onChange).toHaveBeenCalledTimes(1);
  const next = vi.mocked(props.onChange).mock.calls[0]![0];
  expect(next.keyframes!.map(frame => frame.ms)).toEqual([0, 500, 1000]);
  await render({ clip: next }); await click(byLabel("时间点 500 毫秒"));
  expect(props.onSeek).toHaveBeenLastCalledWith(3500);
  const select = byLabel("关键帧缓动") as HTMLSelectElement;
  await act(async () => { select.value = "in"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0].keyframes!.find(frame => frame.ms === 500)!.ease).toBe("in");
  await key(byLabel("时间点 500 毫秒"), "Delete");
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0].keyframes!.map(frame => frame.ms)).toEqual([0, 1000]);
  await click(byLabel("动画水平位置"));
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0].keyframes!.find(frame => frame.ms === 500)).not.toHaveProperty("x");
});

it("supports keyboard timing/position with collisions rejected and locked clips remaining seekable", async () => {
  await render(); await key(byLabel("时间点 0 毫秒"), "ArrowRight");
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0].keyframes![0]).toMatchObject({ ms: 33, rotate: 20, ease: "out" });
  await key(byLabel("路径点 0 毫秒"), "ArrowDown");
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0].keyframes![0]).toMatchObject({ ms: 0, y: 0.01, rotate: 20 });
  vi.mocked(props.onChange).mockClear();
  await render({ locked: true }); await click(byLabel("时间点 1000 毫秒"));
  expect(props.onSeek).toHaveBeenLastCalledWith(4000);
  await key(byLabel("路径点 0 毫秒"), "ArrowDown"); await click(button("录制拖动手势"));
  expect(props.onChange).not.toHaveBeenCalled(); expect(button("添加当前帧").disabled).toBe(true);
  expect(host.textContent).toContain("只读");
});

it("previews time drag then commits once; colliding drop and Escape write nothing", async () => {
  await render(); const timeline = byLabel("关键帧时间轴"); rect(timeline);
  await pointer(byLabel("时间点 0 毫秒"), "pointerdown", 12, 32);
  await pointer(timeline, "pointermove", 81, 32);
  expect(props.onChange).not.toHaveBeenCalled(); expect(byLabel("时间点 500 毫秒")).toBeTruthy();
  await pointer(timeline, "pointerup", 81, 32);
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(vi.mocked(props.onChange).mock.calls[0]![0].keyframes![0]!.ms).toBe(500);
  vi.mocked(props.onChange).mockClear();
  await pointer(byLabel("时间点 0 毫秒"), "pointerdown", 12, 32);
  await pointer(timeline, "pointermove", 150, 32);
  await pointer(timeline, "pointerup", 150, 32);
  expect(props.onChange).not.toHaveBeenCalled(); expect(host.textContent).toContain("已有关键帧");
  await pointer(byLabel("时间点 0 毫秒"), "pointerdown", 12, 32);
  await pointer(timeline, "pointermove", 81, 32); await key(window.document.body, "Escape");
  await pointer(timeline, "pointerup", 81, 32); expect(props.onChange).not.toHaveBeenCalled();
});

it("edits path points and records a gesture as one merged change, with cancel and external-update safety", async () => {
  await render(); const canvas = byLabel("画面路径画布"); rect(canvas);
  await pointer(byLabel("路径点 0 毫秒"), "pointerdown", 85, 90);
  await pointer(canvas, "pointermove", 280, 20); await pointer(canvas, "pointerup", 280, 20);
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(vi.mocked(props.onChange).mock.calls[0]![0].keyframes![0]).toMatchObject({ ms: 0, x: 1, y: -1, rotate: 20, ease: "out" });
  vi.mocked(props.onChange).mockClear(); await click(button("录制拖动手势"));
  await pointer(canvas, "pointerdown", 20, 160, 10);
  await pointer(canvas, "pointermove", 150, 20, 70);
  expect(props.onChange).not.toHaveBeenCalled();
  await pointer(canvas, "pointerup", 280, 160, 130);
  expect(props.onChange).toHaveBeenCalledTimes(1);
  const next = vi.mocked(props.onChange).mock.calls[0]![0];
  expect(next.keyframes!.length).toBeLessThanOrEqual(32);
  expect(next.keyframes!.find(frame => frame.ms === 1000)).toMatchObject({ opacity: 0.4 });
  expect(next.keyframes!.at(-1)!.ms).toBe(2000);
  vi.mocked(props.onChange).mockClear(); await click(button("录制拖动手势"));
  await pointer(canvas, "pointerdown", 20, 20, 200); await pointer(canvas, "pointermove", 280, 160, 260);
  await render({ clip: { ...props.clip, opacity: 0.2 } });
  await pointer(canvas, "pointerup", 280, 160, 300); expect(props.onChange).not.toHaveBeenCalled();
});

it("pointer cancellation or locking mid-recording never commits; empty final deletion omits array", async () => {
  await render({ clip: { ...base(), keyframes: [{ ms: 0, x: 0 }] } });
  await click(button("录制拖动手势")); const canvas = byLabel("画面路径画布"); rect(canvas);
  await pointer(canvas, "pointerdown", 20, 20); await pointer(canvas, "pointermove", 280, 160, 100);
  await pointer(canvas, "pointercancel", 280, 160, 110); expect(props.onChange).not.toHaveBeenCalled();
  await click(button("录制拖动手势")); await pointer(canvas, "pointerdown", 20, 20);
  await pointer(canvas, "pointermove", 280, 160, 100); await render({ locked: true });
  await pointer(canvas, "pointerup", 280, 160, 120); expect(props.onChange).not.toHaveBeenCalled();
  await render({ locked: false }); await click(byLabel("时间点 0 毫秒")); await click(button("删除所选"));
  expect(vi.mocked(props.onChange).mock.calls.at(-1)![0]).not.toHaveProperty("keyframes");
});
