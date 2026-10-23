// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneEffect, type SceneScriptProject } from "@glintai/scenescript";
import { EffectsPanel } from "./EffectsPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const fixture = (effects?: SceneEffect[], locked = false) => parseProject({
  schemaVersion: 1, id: "effects-panel", title: "Effects", aspect: "16:9", knowledgeSources: [],
  scenes: [
    { id: "one", kind: "title", title: "One", narration: { text: "字幕", durationMs: 1000 }, effects, locked },
    { id: "two", kind: "title", title: "Two", narration: { text: "其他场景", durationMs: 1000 },
      effects: [{ id: "other", kind: "contrast", value: 1.2 }] },
  ],
});
async function mount(initial = fixture(), sceneId = "one") {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  let current = initial;
  let replace = (_project: SceneScriptProject) => {};
  const changes: SceneScriptProject[] = [];
  function Harness() {
    const [project, setProject] = useState(initial);
    current = project; replace = setProject;
    return createElement(EffectsPanel, { project, sceneId,
      onChange: next => { changes.push(next); setProject(next); } });
  }
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(Harness)));
  return { container, changes, current: () => current, effects: () => current.scenes[0]!.effects ?? [],
    replace: async (next: SceneScriptProject) => { await act(async () => replace(next)); } };
}
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll("button")]
  .find(item => item.getAttribute("aria-label") === name || item.textContent === name)!;
const click = async (root: HTMLElement, name: string) => { await act(async () => button(root, name).click()); };
async function input(root: HTMLElement, label: string, value: string) {
  const element = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(root: HTMLElement, value: string, label = "效果类型") {
  const element = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
const status = (root: HTMLElement) => root.querySelector('[role="status"]')?.textContent;
const alert = (root: HTMLElement) => root.querySelector('[role="alert"]')?.textContent;

describe("simple scene effects user controls", () => {
  it("applies every local preset, explicitly clears the stack, and preserves other scenes and props", async () => {
    const initial = fixture(); const snapshot = structuredClone(initial);
    const h = await mount(initial);
    expect(h.container.textContent).toContain("画面风格");
    expect(h.container.textContent).toContain("包含字幕和文字");
    expect(h.container.textContent).toContain("原色会清空全部效果");
    expect(h.container.textContent).toContain("当前为原色");
    for (const [name, expected] of [
      ["黑白", [["grayscale", 1]]], ["复古", [["sepia", 0.65], ["contrast", 1.1]]],
      ["清透", [["brightness", 1.08], ["saturate", 1.12]]],
    ] as const) {
      await click(h.container, name);
      expect(h.effects().map(item => [item.kind, item.value])).toEqual(expected);
      expect(status(h.container)).toContain(`已应用${name}`);
      expect(parseProject(h.current())).toEqual(h.current());
    }
    await click(h.container, "原色");
    expect(h.effects()).toEqual([]); expect(status(h.container)).toContain("已清空全部效果");
    expect(h.current().scenes[1]).toEqual(initial.scenes[1]); expect(initial).toEqual(snapshot);
  });

  it("applies presets atomically to all scenes with unique ids, keeps individual edits local, and accepts parent undo", async () => {
    const initial = fixture(); const snapshot = structuredClone(initial);
    const h = await mount(initial);
    expect(h.container.querySelector<HTMLSelectElement>('select[aria-label="应用范围"]')!.value).toBe("current");
    await select(h.container, "all", "应用范围"); expect(h.changes).toHaveLength(0);
    expect(h.container.textContent).toContain("单项调整只改当前场景");
    await click(h.container, "清透");
    expect(h.changes).toHaveLength(1);
    for (const scene of h.current().scenes) {
      expect(scene.effects?.map(item => [item.kind, item.value])).toEqual([["brightness", 1.08], ["saturate", 1.12]]);
    }
    expect(new Set(h.current().scenes.flatMap(scene => scene.effects!.map(item => item.id))).size).toBe(4);
    expect(status(h.container)).toContain("全部场景");
    const other = structuredClone(h.current().scenes[1]);
    await input(h.container, "1 · 亮度 数值", "1.5"); await click(h.container, "添加效果");
    expect(h.current().scenes[1]).toEqual(other);
    await h.replace(initial); expect(h.current()).toEqual(snapshot);
    expect(h.effects()).toEqual([]); expect(initial).toEqual(snapshot);
    await click(h.container, "原色");
    expect(h.current().scenes.map(scene => scene.effects)).toEqual([[], []]);
  });

  it.each(["locked", "animated"])("refuses all preset changes if any target is %s without partial writes", async reason => {
    const initial = fixture();
    if (reason === "locked") initial.scenes[1]!.locked = true;
    else initial.scenes[1]!.effects = [{ id: "animated-other", kind: "contrast", value: 1,
      keyframes: [{ atMs: 0, value: 1 }, { atMs: 500, value: 2 }] }];
    const snapshot = structuredClone(initial); const h = await mount(initial);
    await select(h.container, "all", "应用范围");
    expect(h.container.textContent).toContain(reason === "locked" ? "应用范围内有已锁定场景" : "含关键帧");
    for (const name of ["原色", "黑白", "复古", "清透"]) {
      expect(button(h.container, name).disabled).toBe(true); await click(h.container, name);
    }
    expect(h.changes).toHaveLength(0); expect(h.current()).toEqual(snapshot);
    await select(h.container, "current", "应用范围"); await click(h.container, "黑白");
    expect(h.effects().map(item => item.kind)).toEqual(["grayscale"]);
    expect(h.current().scenes[1]).toEqual(snapshot.scenes[1]);
  });

  it.each([
    ["brightness", "亮度", 0, 3], ["contrast", "对比度", 0, 3], ["saturate", "饱和度", 0, 3],
    ["grayscale", "黑白", 0, 1], ["sepia", "复古", 0, 1], ["hue", "色相（度）", -180, 180],
    ["blur", "模糊（像素）", 0, 30],
  ] as const)("adds %s and edits both numeric and range controls at bounds", async (kind, label, min, max) => {
    const h = await mount();
    await select(h.container, kind); expect(h.changes).toHaveLength(0);
    await click(h.container, "添加效果");
    const effect = h.effects()[0]!;
    expect(effect.kind).toBe(kind); expect(effect.id).toMatch(/^effect-[a-f0-9-]{36}$/);
    const number = h.container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect([number.min, number.max]).toEqual([String(min), String(max)]);
    await input(h.container, `1 · ${label} 数值`, String(max));
    expect(h.effects()[0]!.value).toBe(max);
    expect(h.container.querySelector<HTMLInputElement>(`input[aria-label="1 · ${label} 滑块"]`)!.value).toBe(String(max));
    await input(h.container, `1 · ${label} 滑块`, String(min));
    expect(h.effects()[0]!.value).toBe(min); expect(number.value).toBe(String(min));
  });

  it("applies original local looks at selected strength without claiming official simulations", async () => {
    const h = await mount();
    await input(h.container, "预设强度", "50");
    await click(h.container, "低彩纪实");
    expect(h.effects().map(item => item.kind)).toEqual(["saturate", "contrast"]);
    expect(h.effects()[0]!.value).toBeCloseTo(0.89);
    expect(h.effects()[1]!.value).toBeCloseTo(1.03);
    expect(h.container.textContent).toContain("不是任何相机品牌的官方模拟");
    await input(h.container, "预设强度", "0"); await click(h.container, "克制印色");
    expect(h.effects()).toEqual([]);
  });
  it("rejects empty and out-of-range numbers without changes and recovers on valid input", async () => {
    const h = await mount(fixture([{ id: "a", kind: "brightness", value: 1 }]));
    for (const value of ["", "-1", "3.01"]) {
      await input(h.container, "1 · 亮度 数值", value);
      expect(alert(h.container)).toContain("有效数值"); expect(h.changes).toHaveLength(0);
      expect(h.effects()[0]!.value).toBe(1);
    }
    await input(h.container, "1 · 亮度 数值", "1.25");
    expect(h.effects()[0]!.value).toBe(1.25); expect(alert(h.container)).toBeUndefined();
  });

  it("reorders, toggles, deletes, and uses fresh ids on repeated append", async () => {
    const h = await mount();
    await click(h.container, "复古");
    const originalIds = h.effects().map(item => item.id);
    expect(button(h.container, "上移 1 · 复古").disabled).toBe(true);
    expect(button(h.container, "下移 2 · 对比度").disabled).toBe(true);
    await click(h.container, "下移 1 · 复古");
    expect(h.effects().map(item => item.id)).toEqual([...originalIds].reverse());
    await click(h.container, "上移 2 · 复古");
    expect(h.effects().map(item => item.id)).toEqual(originalIds);
    await act(async () => h.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(h.effects()[0]!.enabled).toBe(false);
    expect(h.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await act(async () => h.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(h.effects()[0]!.enabled).toBe(true);
    await click(h.container, "删除 1 · 复古"); expect(h.effects().map(item => item.kind)).toEqual(["contrast"]);
    await click(h.container, "添加效果"); await click(h.container, "添加效果");
    expect(new Set(h.effects().map(item => item.id)).size).toBe(3);
  });

  it("locks all editing and resumes from replacement controlled props", async () => {
    const initial = fixture([{ id: "a", kind: "brightness", value: 1 }], true);
    const h = await mount(initial);
    expect(h.container.textContent).toContain("请先解锁");
    for (const item of h.container.querySelectorAll<HTMLInputElement>("button, input, select")) {
      expect(item.matches(":disabled")).toBe(true); item.click();
    }
    await input(h.container, "1 · 亮度 数值", "2");
    expect(h.changes).toHaveLength(0); expect(h.current()).toEqual(initial);
    await h.replace(fixture([{ id: "a", kind: "brightness", value: 1 }]));
    await click(h.container, "清透"); expect(h.effects().map(item => item.value)).toEqual([1.08, 1.12]);
  });

  it("does not edit another scene for an unknown or empty scene selection", async () => {
    const initial = fixture(); const h = await mount(initial, "missing");
    expect(status(h.container)).toContain("未找到当前场景");
    expect(h.container.querySelector("button, input, select")).toBeNull();
    expect(h.changes).toHaveLength(0); expect(h.current()).toEqual(initial);
    await h.replace({ ...initial, scenes: [] });
    expect(status(h.container)).toContain("未找到当前场景");
  });

  it("preserves keyframes and timing, blocks static/preset writes, but permits explicit stack edits", async () => {
    const animated: SceneEffect = { id: "animated", kind: "brightness", value: 1, startMs: 100, endMs: 900,
      keyframes: [{ atMs: 100, value: 0.5, easing: "ease-in" }, { atMs: 800, value: 2 }] };
    const initial = fixture([animated, { id: "static", kind: "contrast", value: 1 }]);
    const snapshot = structuredClone(initial); const h = await mount(initial);
    expect(h.container.textContent).toContain("此效果含关键帧，静态参数不会覆盖动画");
    for (const name of ["原色", "黑白", "复古", "清透"]) {
      expect(button(h.container, name).matches(":disabled")).toBe(true); await click(h.container, name);
    }
    for (const label of ["1 · 亮度 数值", "1 · 亮度 滑块"]) {
      expect(h.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.disabled).toBe(true);
    }
    await input(h.container, "1 · 亮度 数值", "2"); expect(h.changes).toHaveLength(0);
    await click(h.container, "下移 1 · 亮度");
    expect(h.effects()[1]).toEqual(animated);
    await act(async () => h.container.querySelector<HTMLInputElement>('input[aria-label="启用 2 · 亮度"]')!.click());
    expect(h.effects()[1]).toEqual({ ...animated, enabled: false });
    await input(h.container, "1 · 对比度 数值", "1.2"); await click(h.container, "添加效果");
    expect(h.effects()[1]).toEqual({ ...animated, enabled: false });
    await click(h.container, "删除 2 · 亮度");
    expect(h.effects().some(item => item.keyframes)).toBe(false);
    await click(h.container, "原色"); expect(h.effects()).toEqual([]); expect(initial).toEqual(snapshot);
  });

  it("caps the stack at 16 and permits delete then append", async () => {
    const h = await mount(fixture(Array.from({ length: 15 }, (_, i) => ({ id: `fx-${i}`, kind: "blur", value: 1 }))));
    await click(h.container, "添加效果"); expect(h.effects()).toHaveLength(16);
    expect(button(h.container, "添加效果").disabled).toBe(true);
    await click(h.container, "添加效果"); expect(h.changes).toHaveLength(1);
    await click(h.container, "删除 1 · 模糊（像素）"); await click(h.container, "添加效果");
    expect(h.effects()).toHaveLength(16); expect(new Set(h.effects().map(item => item.id)).size).toBe(16);
  });

  it("refuses UUID collisions rather than generating duplicate ids", async () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    const h = await mount(fixture([{ id: `effect-${uuid}`, kind: "blur", value: 1 }]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    await click(h.container, "添加效果");
    expect(h.changes).toHaveLength(0); expect(h.effects()).toHaveLength(1);
    expect(alert(h.container)).toContain("未保存");
  });

  it("rejects a duplicate UUID across all-scene preset stacks without partial writes", async () => {
    const initial = fixture(); const h = await mount(initial);
    await select(h.container, "all", "应用范围");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    await click(h.container, "黑白");
    expect(h.changes).toHaveLength(0); expect(h.current()).toEqual(initial);
    expect(alert(h.container)).toContain("未保存");
  });

  it("validates the entire proposed project before calling onChange", async () => {
    const initial = fixture(); initial.scenes[1]!.narration.durationMs = -1;
    const h = await mount(initial);
    await click(h.container, "黑白");
    expect(h.changes).toHaveLength(0); expect(h.effects()).toEqual([]);
    expect(alert(h.container)).toContain("检查参数范围和项目数据");
  });
});
