// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { NleClip } from "@glintai/scenescript";
import { NleMotionEditor } from "./NleMotionEditor";

it("retains keyboard focus after retiming and lets values commit on Enter but revert on Escape", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let clip: NleClip = { id: "focus", kind: "text", text: "键盘", startMs: 0, durationMs: 2000, keyframes: [{ ms: 0, x: 0, y: 0 }, { ms: 1000, x: 1 }] };
  const changes = vi.fn((next: NleClip) => { clip = next; draw(); });
  const draw = () => root.render(createElement(NleMotionEditor, { clip, fps: 30, playheadMs: 0, onSeek: vi.fn(), onChange: changes }));
  const label = (name: string) => host.querySelector(`[aria-label="${name}"]`)!;
  const press = async (element: Element, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  const input = async (element: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => draw());
    await act(async () => { (label("时间点 0 毫秒") as SVGElement).focus(); });
    await press(label("时间点 0 毫秒"), "ArrowRight");
    expect(document.activeElement).toBe(label("时间点 33 毫秒"));
    await press(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(label("时间点 67 毫秒"));
    expect(clip.keyframes![0]!.ms).toBe(67);
    const x = label("水平位置值") as HTMLInputElement;
    await act(async () => x.focus()); await input(x, "0.8"); await press(x, "Escape");
    expect(clip.keyframes![0]!.x).toBe(0);
    await act(async () => x.focus()); await input(x, "0.6"); await press(x, "Enter");
    expect(clip.keyframes![0]!.x).toBe(0.6);
    expect(changes).toHaveBeenCalledTimes(3);
    for (const [name, field, value] of [["垂直位置值", "y", "-0.4"], ["缩放值", "scale", "2.5"], ["旋转值", "rotate", "90"], ["不透明度值", "opacity", "0.25"]] as const) {
      const control = label(name) as HTMLInputElement;
      await act(async () => control.focus()); await input(control, value); await press(control, "Enter");
      expect(clip.keyframes![0]![field]).toBe(Number(value));
    }
    const rotate = label("旋转值") as HTMLInputElement;
    await act(async () => rotate.focus()); await input(rotate, "999"); await press(rotate, "Enter");
    expect(clip.keyframes![0]!.rotate).toBe(90); expect(rotate.value).toBe("90");
  } finally { await act(async () => root.unmount()); host.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; }
});
