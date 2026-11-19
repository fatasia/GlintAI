import { expect, it } from "vitest";
import { createMediaWork } from "./media-work-start";

it("creates an ordinary editable project from an adopted video and its measured duration", () => {
  const work = createMediaWork({ url: "/api/media/assets/tea.mp4", origin: "generated", source: "task-1" }, 4200, "9:16", "茶馆", "video-1");
  expect(work.project.id).toBe("video-1"); expect(work.project.aspect).toBe("9:16");
  expect(work.project.scenes[0]).toMatchObject({ kind: "video", src: "assets/tea.mp4", narration: { durationMs: 4200 }, provenance: { origin: "generated", source: "task-1" } });
  expect(work.generatedSource).toBe(false);
});
it.each(["https://outside.invalid/tea.mp4", "/api/media/assets/../tea.mp4", "/api/media/assets/tea.mp4?x=1", "/api/media/assets/a.png"])("rejects non-managed video %s", url => {
  expect(() => createMediaWork({ url, origin: "footage" }, 3000, "16:9", "作品", "video-1")).toThrow();
});
it.each([0, -1, NaN, Infinity])( "refuses an unmeasured duration %s", duration => {
  expect(() => createMediaWork({ url: "/assets/a.mp4", origin: "footage" }, duration, "16:9", "作品", "video-1")).toThrow();
});
