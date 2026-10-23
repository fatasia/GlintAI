// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { TimelinePanel } from "./TimelinePanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });

const fixture = (extra: Record<string, unknown> = {}) => parseProject({
  schemaVersion: 1, id: "timeline-panel", title: "Timeline", aspect: "16:9", knowledgeSources: [],
  scenes: [
    { id: "one", kind: "title", title: "One", narration: { text: "第一段旁白", durationMs: 1000 }, ...extra },
    { id: "two", kind: "title", title: "Two", narration: { text: "第二段旁白", durationMs: 2000 } },
    { id: "three", kind: "title", title: "Three", narration: { text: "第三段旁白", durationMs: 1000 } },
  ],
});

async function mount(initial = fixture(), selected = "one", followSelection = true, selectable = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let current = initial;
  let replace = (_project: SceneScriptProject) => {};
  const changes: SceneScriptProject[] = [];
  const selections: string[] = [];
  function Harness() {
    const [project, setProject] = useState(initial);
    const [selection, setSelection] = useState(selected);
    current = project; replace = setProject;
    return createElement(TimelinePanel, { project, selectedSceneId: selection,
      onChange: next => { changes.push(next); setProject(next); },
      onSelect: selectable ? id => { selections.push(id); if (followSelection) setSelection(id); } : undefined,
    });
  }
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(Harness)); });
  return { container, changes, selections, current: () => current,
    replace: async (project: SceneScriptProject) => { await act(async () => replace(project)); } };
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find(item => item.textContent === text)!;
const click = async (root: HTMLElement, text: string) => { await act(async () => button(root, text).click()); };
const select = async (root: HTMLElement, id: string) => {
  await act(async () => { root.querySelector<HTMLButtonElement>(`button[aria-label="选择场景 ${id}"]`)!.click(); });
};
const setPosition = async (root: HTMLElement, value: string) => {
  const input = root.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const consent = async (root: HTMLElement) => {
  await act(async () => { root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
};
const durations = (project: SceneScriptProject) => buildTimeline(project).entries.map(entry => entry.durationMs);
const status = (root: HTMLElement) => root.querySelector('[role="status"]')?.textContent;
const alert = (root: HTMLElement) => root.querySelector('[role="alert"]')?.textContent;

describe("scene-level timeline user commands", () => {
  it("selects duration-proportional scenes and performs repeated trims and rolls", async () => {
    const initial = fixture();
    const { container, current, changes, selections } = await mount(initial);
    const sceneButtons = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
    expect(sceneButtons.map(item => item.style.flexGrow)).toEqual(["1000", "2000", "1000"]);
    expect(container.querySelector('[aria-label="时间线总时长"]')?.textContent).toContain("4.00 秒");
    await select(container, "two");
    expect(selections).toEqual(["two"]);
    expect(container.querySelector('[aria-label="选择场景 two"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(changes).toHaveLength(0);
    await click(container, "末尾 −100 毫秒");
    expect(durations(current())).toEqual([1000, 1900, 1000]);
    expect(status(container)).toContain("缩短 100");
    expect(container.querySelector('[aria-label="时间线总时长"]')?.textContent).toContain("3.90 秒");
    await click(container, "末尾 +100 毫秒");
    expect(durations(current())).toEqual([1000, 2000, 1000]);
    expect(status(container)).toContain("延长 100");
    await click(container, "滚动边界 +100 毫秒");
    expect(durations(current())).toEqual([1000, 2100, 900]);
    expect(buildTimeline(current()).totalMs).toBe(4000);
    expect(status(container)).toContain("后移 100");
    await click(container, "滚动边界 −100 毫秒");
    expect(durations(current())).toEqual([1000, 2000, 1000]);
    expect(status(container)).toContain("前移 100");
    expect(initial).toEqual(fixture());
  });

  it("requires explicit narration duplication, uses local milliseconds, and never persists controls", async () => {
    const { container, current, changes } = await mount();
    const snapshot = structuredClone(current());
    await setPosition(container, "300");
    expect(current()).toEqual(snapshot);
    expect(changes).toHaveLength(0);
    await click(container, "在此分割");
    expect(alert(container)).toContain("勾选");
    expect(changes).toHaveLength(0);
    await consent(container);
    expect(changes).toHaveLength(0);
    await click(container, "在此分割");
    expect(current().scenes).toHaveLength(4);
    expect(durations(current())).toEqual([300, 700, 2000, 1000]);
    expect(current().scenes.slice(0, 2).map(scene => scene.narration.text)).toEqual(["第一段旁白", "第一段旁白"]);
    expect(new Set(current().scenes.map(scene => scene.id)).size).toBe(4);
    expect(buildTimeline(current()).totalMs).toBe(4000);
    expect(status(container)).toContain("已分割");
    expect(alert(container)).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(Object.keys(current()).sort()).toEqual(Object.keys(snapshot).sort());
    expect(current()).not.toHaveProperty("splitMs");
    expect(current()).not.toHaveProperty("playheadMs");
  });

  it.each(["", "-1", "99", "901", "1000", "2000", "100.5"])("refuses invalid split position %j without changes", async value => {
    const { container, current, changes } = await mount();
    const snapshot = structuredClone(current());
    await consent(container); await setPosition(container, value); await click(container, "在此分割");
    expect(alert(container)).toMatch(/整数|至少保留 100/);
    expect(changes).toHaveLength(0); expect(current()).toEqual(snapshot);
  });

  it("locks all destructive controls until unlocked and resets split consent on selection", async () => {
    const { container, current, changes } = await mount();
    await consent(container);
    await select(container, "two");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await click(container, "锁定当前场景");
    expect(current().scenes[1]!.locked).toBe(true);
    expect(status(container)).toContain("已锁定");
    for (const name of ["末尾 −100 毫秒", "末尾 +100 毫秒", "滚动边界 −100 毫秒", "滚动边界 +100 毫秒", "在此分割", "波纹删除当前场景"]) {
      expect(button(container, name).matches(":disabled")).toBe(true);
      await click(container, name);
    }
    expect(changes).toHaveLength(1); expect(durations(current())).toEqual([1000, 2000, 1000]);
    await click(container, "解锁当前场景");
    expect(status(container)).toContain("已解锁");
    await click(container, "末尾 −100 毫秒");
    expect(durations(current())).toEqual([1000, 1900, 1000]);
  });

  it("refuses edits that would move a locked downstream scene", async () => {
    const initial = fixture(); initial.scenes[1]!.locked = true;
    const { container, changes, current } = await mount(initial);
    for (const name of ["末尾 −100 毫秒", "滚动边界 +100 毫秒", "波纹删除当前场景"]) {
      await click(container, name); expect(alert(container)).toContain("已锁定");
    }
    expect(changes).toHaveLength(0); expect(current()).toEqual(initial);
  });

  it.each([
    { narration: { text: "音频", durationMs: 1000, audioRef: "voice.mp3" } },
    { narration: { text: "词时间", durationMs: 1000, segments: [{ text: "词", words: [{ text: "词", startMs: 0, endMs: 500 }] }] } },
    { narration: { text: "偏移", durationMs: 1000, audioOffsetMs: 10 } },
    { elements: [{ id: "label", kind: "text", text: "A" }], tracks: [{ elementId: "label", property: "x", keyframes: [{ atMs: 0, value: 0 }] }] },
    { camera: { type: "push" } },
    { transition: { in: "fade" } },
  ])("shows an alert and preserves unsupported content: %j", async extra => {
    const initial = fixture(extra);
    const { container, current, changes } = await mount(initial);
    await consent(container);
    for (const name of ["末尾 −100 毫秒", "末尾 +100 毫秒", "在此分割", "滚动边界 +100 毫秒"]) {
      await click(container, name);
      expect(alert(container)).toMatch(/音频或旁白词时间|动画、转场或音效/);
      expect(status(container)).toBeUndefined();
    }
    expect(changes).toHaveLength(0); expect(current()).toEqual(initial);
  });

  it("ripple deletes a selected scene, selects its neighbor and safely handles stale parent selection", async () => {
    const { container, current, selections } = await mount(fixture(), "two", false);
    await click(container, "波纹删除当前场景");
    expect(current().scenes.map(scene => scene.id)).toEqual(["one", "three"]);
    expect(buildTimeline(current()).entries.map(entry => entry.startMs)).toEqual([0, 1000]);
    expect(selections).toEqual(["three"]);
    expect(status(container)).toContain("波纹删除");
    expect(container.textContent).toContain("当前场景：one");
    await click(container, "末尾 −100 毫秒");
    expect(durations(current())).toEqual([900, 1000]);
  });

  it("recovers when selected scene is removed externally and supports selection without onSelect", async () => {
    const harness = await mount(fixture(), "one", true, false);
    await select(harness.container, "two");
    await click(harness.container, "末尾 −100 毫秒");
    expect(durations(harness.current())).toEqual([1000, 1900, 1000]);
    const next = { ...harness.current(), scenes: harness.current().scenes.filter(scene => scene.id !== "two") };
    await harness.replace(next);
    expect(harness.container.textContent).toContain("当前场景：one");
    await click(harness.container, "末尾 +100 毫秒");
    expect(durations(harness.current())).toEqual([1100, 1000]);
  });

  it("guards the final scene, missing roll neighbor, minimum duration, and empty projects", async () => {
    const initial = fixture(); initial.scenes = initial.scenes.slice(0, 1);
    initial.scenes[0]!.narration.durationMs = 100;
    const { container, current, changes, replace } = await mount(initial, "missing");
    for (const [name, expected] of [["波纹删除当前场景", /最后一个/], ["滚动边界 +100 毫秒", /下一个/], ["末尾 −100 毫秒", /至少保留 100/]] as const) {
      await click(container, name); expect(alert(container)).toMatch(expected);
    }
    expect(changes).toHaveLength(0); expect(current()).toEqual(initial);
    await replace({ ...initial, scenes: [] });
    expect(container.textContent).toContain("暂无场景");
    expect(button(container, "在此分割")).toBeUndefined();
  });
});
