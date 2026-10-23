import { describe, expect, it } from "vitest";
import {
  cameraTransform,
  easeOutCubic,
  flashOverlayOpacity,
  placeSfx,
  transitionDurationFrames,
  transitionStyle,
  DEFAULT_TRANSITION_MS,
} from "./motion";

describe("cameraTransform", () => {
  it("is identity for static/undefined and single-frame scenes", () => {
    expect(cameraTransform(undefined, 10, 100)).toEqual({ scale: 1, translateX: 0, translateY: 0, rotateX: 0 });
    expect(cameraTransform({ type: "static" }, 10, 100).scale).toBe(1);
    expect(cameraTransform({ type: "push" }, 5, 1).scale).toBe(1);
  });

  it("push zooms in monotonically, capped by intensity", () => {
    const start = cameraTransform({ type: "push", intensity: 0.5 }, 0, 100);
    const mid = cameraTransform({ type: "push", intensity: 0.5 }, 50, 100);
    const end = cameraTransform({ type: "push", intensity: 0.5 }, 99, 100);
    expect(start.scale).toBe(1);
    expect(end.scale).toBeGreaterThan(mid.scale!);
    expect(end.scale).toBeLessThanOrEqual(1 + 0.18 * 0.5 + 1e-9);
  });

  it("pull starts zoomed and settles back to scale 1", () => {
    const start = cameraTransform({ type: "pull", intensity: 1 }, 0, 60);
    const end = cameraTransform({ type: "pull", intensity: 1 }, 59, 60);
    expect(start.scale).toBeCloseTo(1.18, 1);
    expect(end.scale).toBeCloseTo(1, 2);
  });

  it("pan-left scans positive→negative and pan-right mirrors it", () => {
    const start = cameraTransform({ type: "pan-left", intensity: 1 }, 0, 100);
    const end = cameraTransform({ type: "pan-left", intensity: 1 }, 99, 100);
    expect(start.translateX).toBeGreaterThan(0);
    expect(end.translateX).toBeLessThan(0);
    const rightStart = cameraTransform({ type: "pan-right", intensity: 1 }, 0, 100);
    expect(rightStart.translateX).toBeCloseTo(-start.translateX, 8);
    // Never leaves the ±72px safe travel at max intensity.
    expect(Math.abs(start.translateX)).toBeLessThanOrEqual(36 + 1e-9);
  });

  it("drift returns to its start offset so the cut lands clean", () => {
    const start = cameraTransform({ type: "drift", intensity: 0.8 }, 0, 90);
    const end = cameraTransform({ type: "drift", intensity: 0.8 }, 89, 90);
    expect(start.translateX).toBeCloseTo(end.translateX, 6);
  });
});

describe("transitionStyle", () => {
  it("every type is settled (visible, unclipped) at progress 1", () => {
    for (const type of ["fade", "slide-left", "slide-right", "slide-up", "wipe", "zoom-punch", "iris", "blur", "flip", "flash"] as const) {
      const style = transitionStyle(type, 1);
      expect(style.opacity).toBeGreaterThan(0);
      // A settled transition must not still clip content away.
      expect(style.clipPath).not.toMatch(/100%/);
    }
  });

  it("slide-left enters from the right and lands at zero offset", () => {
    expect(transitionStyle("slide-left", 0).transform).toContain("90px");
    expect(transitionStyle("slide-left", 1).transform).toContain("translateX(0px)");
  });

  it("wipe opens left→right via inset clip", () => {
    expect(transitionStyle("wipe", 0).clipPath).toContain("inset(0 100%");
    expect(transitionStyle("wipe", 1).clipPath).toContain("inset(0 0%");
  });

  it("zoom-punch overshoots scale above 1 at the start", () => {
    expect(transitionStyle("zoom-punch", 0).transform).toContain("1.22");
  });
});

describe("placeSfx", () => {
  const entries = [{
    id: "s1",
    narration: { segments: [{ words: [
      { text: "数", startMs: 0 }, { text: "据", startMs: 200 }, { text: "反", startMs: 400 },
      { text: "转", startMs: 600 }, { text: "了", startMs: 800 },
    ] }] },
    startFrame: 300,
  }];

  it("matches CJK cues across single-character tokens", () => {
    const placed = placeSfx([{ sceneId: "s1", word: "反转", effect: "whoosh" }], entries, 30);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.frame).toBe(300 + Math.round(0.4 * 30));
  });

  it("falls back to the scene start when the word never appears", () => {
    const placed = placeSfx([{ sceneId: "s1", word: "不存在", effect: "impact" }], entries, 30);
    expect(placed[0]!.frame).toBe(300);
  });

  it("skips cues for unknown scenes and fires wordless cues at scene start", () => {
    const placed = placeSfx([
      { sceneId: "ghost", effect: "pop" },
      { sceneId: "s1", effect: "click", gain: 0.9 },
    ], entries, 30);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ frame: 300, effect: "click", volume: 0.9 });
  });
});

describe("transition helpers", () => {
  it("duration derives frames from ms at fps", () => {
    expect(transitionDurationFrames({ in: "fade", durationMs: 500 }, 30)).toBe(15);
    expect(transitionDurationFrames(undefined, 30)).toBe(0);
    expect(transitionDurationFrames({ in: "fade" }, 30)).toBe(Math.round((DEFAULT_TRANSITION_MS / 1000) * 30));
  });

  it("flash afterglow stays inside the first 40% and reaches zero", () => {
    expect(flashOverlayOpacity("fade", 0)).toBe(0);
    expect(flashOverlayOpacity("flash", 0)).toBeGreaterThan(0);
    expect(flashOverlayOpacity("flash", 0.4)).toBeCloseTo(0, 6);
    expect(flashOverlayOpacity("flash", 0.9)).toBe(0);
  });

  it("easeOutCubic clamps outside 0..1", () => {
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(7)).toBe(1);
  });
});
