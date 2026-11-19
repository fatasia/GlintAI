// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { StrokePad, StrokeSettings, sequenceStrokes } from "./StrokeTools";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });
const project = parseProject({ schemaVersion: 1, id: "stroke-pad", title: "Stroke", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Stroke", narration: { text: "Stroke", durationMs: 3000 } }] });
const pathsProject = parseProject({ ...project, scenes: [{ ...project.scenes[0], elements: [
  { id: "a", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d: "M0 0 L100 100", viewBox: [100, 100], stroke: "#ffffff", strokeWidth: 2, drawDurationMs: 500 },
  { id: "b", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d: "M0 100 L100 0", viewBox: [100, 100], stroke: "#ffffff", strokeWidth: 2 },
] }] });

it("sequences paths atomically in layer order and rejects overflow and locked edits", () => {
  const scene = pathsProject.scenes[0]!;
  const next = sequenceStrokes(scene, 200, 100);
  expect(next.elements?.map(item => item.kind === "path" && [item.drawStartMs, item.drawDurationMs])).toEqual([[200, 500], [800, 1500]]);
  expect(scene.elements?.[0]).not.toHaveProperty("drawStartMs");
  expect(() => sequenceStrokes(scene, 1000, 100)).toThrow("超出镜头时长");
  expect(() => sequenceStrokes(scene, 0, -1)).toThrow("非负整数");
  expect(() => sequenceStrokes({ ...scene, locked: true }, 0, 0)).toThrow("不可编辑");
  expect(() => sequenceStrokes(project.scenes[0]!, 0, 0)).toThrow("至少需要两条");
  expect(parseProject({ ...pathsProject, scenes: [next] }).scenes[0]).toEqual(next);
});

it("applies sequencing through the user control and reports overflow without changing the scene", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onChange = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StrokePad, { project: pathsProject, scene: pathsProject.scenes[0]!, timeMs: 200, onChange })));
  await act(async () => { const details = host.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  const action = () => [...host.querySelectorAll("button")].find(button => button.textContent === "从播放头顺序绘制")!;
  await act(async () => action().click());
  expect(onChange).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("已按对象顺序编排");
  await act(async () => root.render(createElement(StrokePad, { project: pathsProject, scene: pathsProject.scenes[0]!, timeMs: 1500, onChange })));
  await act(async () => action().click());
  expect(onChange).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("超出镜头时长");
});

it("requires confirmation, rejects stale drawings and keeps locked scenes unchanged", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onChange = vi.fn();
  dispose = () => act(() => root.unmount());
  const render = async (scene = project.scenes[0]!) => act(async () => root.render(createElement(StrokePad, { project, scene, timeMs: 200, onChange })));
  await render();
  await act(async () => { const details = host.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="新路径数据"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "M100 100 Q400 700 800 300"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(onChange).not.toHaveBeenCalled();
  const add = () => [...host.querySelectorAll("button")].find(button => button.textContent === "加入镜头")!;
  expect(add().disabled).toBe(false);
  await render({ ...project.scenes[0]!, notes: "another edit" });
  await act(async () => add().click());
  expect(onChange).not.toHaveBeenCalled(); expect(host.textContent).toContain("镜头已变化");
  await render({ ...project.scenes[0]!, locked: true });
  expect(add().disabled).toBe(true); expect(textarea.disabled).toBe(true);
});

it("retains the path draft when the editor rejects the candidate", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onChange = vi.fn(() => false);
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StrokePad, { project, scene: project.scenes[0]!, timeMs: 0, onChange })));
  await act(async () => { const details = host.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="新路径数据"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "M100 100 L800 300"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "加入镜头")!.click());
  expect(onChange).toHaveBeenCalledTimes(1); expect(textarea.value).toBe("M100 100 L800 300"); expect(host.textContent).toContain("草稿已保留");
});

it("preserves the draft when a new stroke would extend beyond the shot", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onChange = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StrokePad, { project, scene: project.scenes[0]!, timeMs: 2000, onChange })));
  await act(async () => { const details = host.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="新路径数据"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "M0 0 L100 100"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "加入镜头")!.click());
  expect(onChange).not.toHaveBeenCalled(); expect(textarea.value).toBe("M0 0 L100 100"); expect(host.textContent).toContain("超出镜头时长");
  await act(async () => root.render(createElement(StrokePad, { project, scene: project.scenes[0]!, timeMs: 1500, onChange })));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "加入镜头")!.click());
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("does not overwrite start time when its number field is cleared", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onChange = vi.fn(() => true);
  dispose = () => act(() => root.unmount());
  const element = pathsProject.scenes[0]!.elements![0]!;
  if (element.kind !== "path") throw new Error("Expected path");
  await act(async () => root.render(createElement(StrokeSettings, { element: { ...element, drawStartMs: 300 }, revision: "one", onChange })));
  const field = host.querySelector<HTMLInputElement>('[aria-label="路径起笔时间"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, ""); field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "0"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ drawStartMs: 0 }));
});
