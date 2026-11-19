// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { setShapeMorph, ShapeMorphPanel } from "./ShapeMorphPanel";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {}; afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const project = parseProject({ schemaVersion: 1, id: "morph-editor", title: "形变", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "一", narration: { text: "一", durationMs: 2000 }, elements: [{ id: "box", kind: "rect", x: .3, y: .4, w: .2, h: .2, fill: "#ff0000" }] },
  { id: "two", kind: "title", title: "二", narration: { text: "二", durationMs: 2000 }, elements: [{ id: "box", kind: "rect", x: .7, y: .4, w: .4, h: .2, fill: "#0000ff" }] },
] });
it("sets and removes a morph without mutating other project fields", () => {
  const next = setShapeMorph(project, "two", 600);
  expect(next.scenes[1]!.transition).toEqual({ in: "shape-morph", durationMs: 600 });
  expect(next.scenes[0]).toEqual(project.scenes[0]);
  expect(setShapeMorph(next, "two", null)).toEqual(project);
  expect(project.scenes[1]!.transition).toBeUndefined();
});
it("rejects locked scenes, invalid durations and unsupported existing transitions", () => {
  const locked = parseProject({ ...project, scenes: [project.scenes[0], { ...project.scenes[1], locked: true }] });
  expect(() => setShapeMorph(locked, "two", 800)).toThrow(/锁定/);
  expect(() => setShapeMorph(project, "two", 119)).toThrow(/120/);
  const short = parseProject({ ...project, scenes: [project.scenes[0], { ...project.scenes[1], narration: { text: "二", durationMs: 500 } }] });
  expect(() => setShapeMorph(short, "two", 600)).toThrow(/不能超过/);
  const lockedPrevious = parseProject({ ...project, scenes: [{ ...project.scenes[0], locked: true }, project.scenes[1]] });
  expect(setShapeMorph(lockedPrevious, "two", 800).scenes[0]).toEqual(lockedPrevious.scenes[0]);
  expect(() => setShapeMorph(project, "one", 800)).toThrow(/previous/);
  const fade = parseProject({ ...project, scenes: [project.scenes[0], { ...project.scenes[1], transition: { in: "fade" } }] });
  expect(() => setShapeMorph(fade, "two", 800)).toThrow(/确认替换/);
  expect(setShapeMorph(fade, "two", 800, true).scenes[1]!.transition?.in).toBe("shape-morph");
  const animated = parseProject({ ...project, scenes: [project.scenes[0], { ...project.scenes[1], tracks: [{ elementId: "box", property: "x", keyframes: [{ atMs: 0, value: .5 }] }] }] });
  expect(() => setShapeMorph(animated, "two", 800)).toThrow(/animation tracks/);
});
it("applies a path morph and reports incompatible topology without changing the project", async () => {
  const path = { id: "line", kind: "path", x: .5, y: .5, w: 1, h: 1, d: "M0 0 L80 80", viewBox: [100, 100], stroke: "#000000", strokeWidth: 4 };
  const initial = parseProject({ ...project, scenes: [{ ...project.scenes[0], elements: [path] }, { ...project.scenes[1], elements: [{ ...path, d: "M10 10 Q40 40 80 80" }] }] });
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = initial;
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(ShapeMorphPanel, { project: value, sceneId: "two", onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "应用形变")!.click());
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("路径命令或数量不一致");
  expect(current).toEqual(initial);
  const valid = parseProject({ ...initial, scenes: [initial.scenes[0], { ...initial.scenes[1], elements: [{ ...path, d: "M10 10 L90 90" }] }] });
  expect(setShapeMorph(valid, "two", 600).scenes[1]!.transition?.in).toBe("shape-morph");
});
it("shows matching shapes and edits the selected project only when applied", async () => {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount()); let current: SceneScriptProject = project;
  function Harness() { const [value, setValue] = useState(project); current = value; return createElement(ShapeMorphPanel, { project: value, sceneId: "two", onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  expect(div.textContent).toContain("匹配对象：box");
  const field = div.querySelector<HTMLInputElement>('input[aria-label="形变时长"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "600"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(current.scenes[1]!.transition).toBeUndefined();
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "应用形变")!.click());
  expect(current.scenes[1]!.transition).toMatchObject({ in: "shape-morph", durationMs: 600 });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "移除形变")!.click());
  expect(current.scenes[1]!.transition).toBeUndefined();
});
