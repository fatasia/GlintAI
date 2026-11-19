// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { NleCatalog } from "./NleCatalog";

vi.mock("./NlePreview", () => ({ NlePreview: ({ project }: { project: NleProject }) =>
  createElement("div", { "aria-label": "测试预览" }, project.tracks[0]?.clips[0]?.effects?.map(effect => effect.kind).join(" ")) }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseNleProject({ schemaVersion: 1, id: "catalog-ui", title: "库", fps: 30, width: 640, height: 360, tracks: [
  { id: "t1", kind: "text", name: "文字", clips: [{ id: "title", kind: "text", text: "预览内容", startMs: 0, durationMs: 3000 }] },
] });
const target = { trackId: "t1", clipId: "title" };
let unmount = () => {};
afterEach(() => { unmount(); document.body.innerHTML = ""; });

async function mount(initial = project) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), applied: NleProject[] = [];
  const render = async (value: NleProject, selected = true) => act(async () => root.render(createElement(NleCatalog, {
    project: value, target: selected ? target : null, onApply: next => applied.push(next),
  })));
  await render(initial);
  unmount = () => act(() => root.unmount());
  const click = async (name: string) => act(async () => {
    const element = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === name || button.textContent === name);
    if (!element) throw new Error(`missing control ${name}`);
    element.click();
  });
  return { host, applied, render, click };
}

describe("preset library interactions", () => {
  it("browses and previews without writes; application emits exactly one change with feedback", async () => {
    const h = await mount();
    await h.click("预览低彩纪实");
    expect(h.host.querySelector('[aria-label="测试预览"]')?.textContent).toContain("saturate");
    expect(h.applied).toEqual([]);
    await h.click("应用到选中片段");
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.tracks[0]!.clips[0]!.effects?.[0]).toMatchObject({ kind: "saturate", value: 0.78 });
    expect(h.host.textContent).toContain("已应用低彩纪实，可用撤销恢复");
  });

  it("searches with a useful empty state and resets search when switching catalogs", async () => {
    const h = await mount();
    await act(async () => {
      const input = h.host.querySelector<HTMLInputElement>('[aria-label="搜索滤镜与转场"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "不存在的项");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.host.textContent).toContain("没有匹配的预设");
    await h.click("转场");
    expect(h.host.textContent).toContain("淡入淡出");
    expect(h.host.textContent).not.toContain("没有匹配的预设");
    await h.click("预览擦除");
    await h.click("应用到选中片段");
    expect(h.applied[0]!.tracks[0]!.clips[0]!.transitionIn?.type).toBe("wipe");
  });

  it("blocks locked and missing targets while leaving browsing available", async () => {
    const locked = parseNleProject({ ...project, tracks: project.tracks.map(track => ({ ...track, locked: true })) });
    const h = await mount(locked);
    await h.click("预览简洁黑白"); await h.click("应用到选中片段");
    expect(h.applied).toEqual([]);
    expect(h.host.textContent).toContain("轨道已锁定");
    await h.render(project, false);
    expect(h.host.textContent).toContain("先在时间线选择");
    expect(h.host.querySelector('[aria-label="预设画面预览"]')).toBeNull();
  });
});
