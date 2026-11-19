// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { createNleSession } from "./nle-session";
import { NleProjectSettings, updateNleProjectSettings } from "./NleProjectSettings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {}; afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const project = parseNleProject({ schemaVersion: 1, id: "settings", title: "剪辑", width: 1920, height: 1080, fps: 30, tracks: [
  { id: "v", kind: "video", name: "画面", clips: [{ id: "pic", kind: "image", src: "assets/photo.png", startMs: 500, durationMs: 1500, transform: { x: 0.2, y: -0.15, scale: 1.25 } }] },
  { id: "t", kind: "text", name: "文字", clips: [{ id: "title", kind: "text", text: "标题", startMs: 0, durationMs: 2000, fontSize: 64, karaoke: true, transform: { x: -0.1, scale: 0.8 }, keyframes: [{ ms: 0, x: 0.1, opacity: 0.7 }, { ms: 1000, x: 0.2, opacity: 1 }] }] },
  { id: "audio", kind: "audio", name: "配乐", clips: [{ id: "song", kind: "audio", src: "assets/music.wav", startMs: 100, durationMs: 1500, volume: 0.5 }] },
] });
it("preserves normalized placement, source and durations while scaling text for 4K", () => {
  const next = updateNleProjectSettings(project, 3840, 24);
  expect(next).toMatchObject({ width: 3840, height: 2160, fps: 24 });
  expect(next.tracks[0]!.clips[0]).toEqual(project.tracks[0]!.clips[0]);
  expect(next.tracks[1]!.clips[0]).toMatchObject({ fontSize: 128, karaoke: true, transform: { x: -0.1, scale: 0.8 }, keyframes: [{ ms: 0, x: 0.1, opacity: 0.7 }, { ms: 1000, x: 0.2, opacity: 1 }], startMs: 0, durationMs: 2000 });
  expect(next.tracks[2]).toEqual(project.tracks[2]);
  const session = createNleSession(project); expect(session.apply(next, "规格").ok).toBe(true); expect(session.undo()).toBe(true); expect(session.document()).toEqual(project);
});
it("preserves portrait aspect and validates fps, small fonts, locked tracks and extreme shapes", () => {
  const vertical = parseNleProject({ ...project, width: 1080, height: 1920 });
  expect(updateNleProjectSettings(vertical, 3840, 30)).toMatchObject({ width: 2160, height: 3840 });
  expect(() => updateNleProjectSettings(project, 3840, 121)).toThrow(/帧率/);
  const locked = parseNleProject({ ...project, tracks: [project.tracks[0], { ...project.tracks[1], locked: true }] });
  expect(() => updateNleProjectSettings(locked, 3840, 30)).toThrow(/锁定/);
  expect(updateNleProjectSettings(locked, undefined, 24).fps).toBe(24);
  const tiny = parseNleProject({ ...project, tracks: [project.tracks[0], { ...project.tracks[1], clips: [{ ...project.tracks[1]!.clips[0], fontSize: 12 }] }] });
  expect(() => updateNleProjectSettings(tiny, 1280, 30)).toThrow(/字号/);
  expect(() => updateNleProjectSettings(parseNleProject({ ...project, width: 16, height: 4320 }), 1280, 30)).toThrow(/画幅/);
});
it("does not commit until confirmation and reports invalid settings", async () => {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount()); await act(async () => root.render(createElement(NleProjectSettings, { project, onApply: apply })));
  await act(async () => div.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "应用规格")!.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("没有变化"); expect(apply).not.toHaveBeenCalled();
  const input = document.querySelector<HTMLInputElement>('[aria-label="项目帧率"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "121"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "应用规格")!.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("帧率"); expect(apply).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "取消")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(apply).not.toHaveBeenCalled();
});
