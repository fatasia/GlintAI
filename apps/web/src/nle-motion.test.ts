import { describe, expect, it } from "vitest";
import { NleClip, nleSampleMotion, parseNleProject } from "@glintai/scenescript";
import { addMotionKeyframe, motionCurvePoints, motionFrameMs, moveMotionKeyframe, patchMotionKeyframe, removeMotionField, removeMotionKeyframe, sampleMotion, stepMotionFrameMs } from "./nle-motion";
import { sampleMotionGesture } from "./nle-motion-record";

const fixture = (): NleClip => ({ id: "motion", kind: "image", src: "assets/fixture.png", startMs: 800, durationMs: 2000, trimStartMs: 90, speed: 1.25, transform: { x: 0.2, y: -0.1, scale: 1.3 }, opacity: 0.7, blend: "screen", mask: { shape: "circle" }, transitionIn: { type: "fade" } });
const projectValid = (clip: NleClip) => parseNleProject({ schemaVersion: 1, id: "motion-test", title: "动效", fps: 30, width: 1920, height: 1080, tracks: [{ id: "visual", kind: "overlay", name: "画面", clips: [clip] }] });

describe("native NLE motion helpers", () => {
  it("snaps directly to integer-ms frame grid at integer/fractional fps and clamps bounds", () => {
    expect(motionFrameMs(500, 2000, 30)).toBe(500);
    expect(motionFrameMs(518, 2000, 30)).toBe(533);
    expect(motionFrameMs(-900, 2000, 30)).toBe(0);
    expect(motionFrameMs(5000, 1010, 30)).toBe(1000);
    expect(motionFrameMs(5000, 2000, 29.97)).toBe(1969);
    for (const fps of [1, 23.976, 29.97, 59.94, 120]) {
      for (let frame = 0; frame < 20; frame++) {
        const ms = motionFrameMs(frame * 1000 / fps, 100000, fps);
        expect(motionFrameMs(ms, 100000, fps)).toBe(ms);
        expect(stepMotionFrameMs(ms, 1, 100000, fps)).toBe(motionFrameMs((frame + 1) * 1000 / fps, 100000, fps));
        if (frame) expect(stepMotionFrameMs(ms, -1, 100000, fps)).toBe(motionFrameMs((frame - 1) * 1000 / fps, 100000, fps));
      }
    }
    for (const invalid of [NaN, Infinity]) expect(() => motionFrameMs(invalid, 2000, 30)).toThrow();
    for (const fps of [0, 121, NaN]) expect(() => motionFrameMs(5, 2000, fps)).toThrow();
  });
  it("adds evaluated values, merges same-ms fields, preserves static/source props and never mutates", () => {
    const clip = fixture(), before = structuredClone(clip);
    const added = addMotionKeyframe(clip, 500, 30);
    expect(clip).toEqual(before);
    expect(added.keyframes).toEqual([{ ms: 500, ...nleSampleMotion(clip, 500) }]);
    const merged = addMotionKeyframe(added, 500, 30, { rotate: 90, ease: "out" });
    expect(merged.keyframes).toHaveLength(1);
    expect(merged.keyframes![0]).toMatchObject({ ms: 500, x: 0.2, opacity: 0.7, rotate: 90, ease: "out" });
    const { keyframes: _frames, ...other } = merged;
    expect(other).toEqual(clip); projectValid(merged);
  });
  it("retimes by sorting without collisions, keeps fields/easing and clamps extreme input", () => {
    const clip = { ...fixture(), keyframes: [{ ms: 0, x: -1, ease: "in" as const }, { ms: 500, y: 0.6, opacity: 0.3 }, { ms: 2000, scale: 2 }] };
    expect(() => moveMotionKeyframe(clip, 500, 0, 30)).toThrow("已有关键帧");
    const moved = moveMotionKeyframe(clip, 500, 1533, 30);
    expect(moved.keyframes!.map(frame => frame.ms)).toEqual([0, 1533, 2000]);
    expect(moved.keyframes![1]).toEqual({ ms: 1533, y: 0.6, opacity: 0.3 });
    expect(() => moveMotionKeyframe(clip, 900, 1000, 30)).toThrow("重新选择");
    expect(() => moveMotionKeyframe(clip, 500, Infinity, 30)).toThrow();
    const bounded = moveMotionKeyframe({ ...fixture(), keyframes: [{ ms: 500, x: 0 }] }, 500, 99999, 30);
    expect(bounded.keyframes![0]!.ms).toBe(2000); projectValid(moved);
  });
  it("removes the final point by omitting keyframes, not writing an invalid empty array", () => {
    const clip = addMotionKeyframe(fixture(), 0, 30, { x: 0.1 });
    const removed = removeMotionKeyframe(clip, 0);
    expect(Object.hasOwn(removed, "keyframes")).toBe(false); expect(removed).toEqual(fixture());
    expect(removeMotionField(clip, 0, "x")).toEqual(fixture());
    projectValid(removed);
    const withUntouchedEmpty = { ...fixture(), keyframes: [{ ms: 0, ease: "in" as const }, { ms: 500, x: 0.2, rotate: 10 }] };
    expect(removeMotionField(withUntouchedEmpty, 500, "x").keyframes).toEqual([{ ms: 0, ease: "in" }, { ms: 500, rotate: 10 }]);
  });
  it("validates property boundaries and supports sparse independent animated fields", () => {
    const clip = { ...fixture(), keyframes: [{ ms: 0, x: -1, ease: "in" as const }, { ms: 500, y: 1 }, { ms: 2000, x: 1, y: -1 }] };
    expect(sampleMotion(clip, 1000)).toEqual(nleSampleMotion(clip, 1000));
    expect(sampleMotion(clip, 1000).x).toBe(-0.5);
    expect(sampleMotion(clip, 1000).scale).toBe(1.3);
    expect(motionCurvePoints(clip, "x")).not.toBe(motionCurvePoints({ ...clip, keyframes: clip.keyframes.map(frame => ({ ...frame, ease: "linear" })) }, "x"));
    for (const patch of [{ x: 2 }, { y: NaN }, { scale: 0 }, { rotate: 181 }, { opacity: -1 }]) expect(() => patchMotionKeyframe(clip, 0, patch)).toThrow();
    expect(patchMotionKeyframe(clip, 0, { opacity: 0 }).keyframes![0]).toMatchObject({ x: -1, ease: "in", opacity: 0 });
  });
  it("rejects point 33 but allows edits at capacity", () => {
    const clip = { ...fixture(), keyframes: Array.from({ length: 32 }, (_, index) => ({ ms: index * 50, x: 0 })) };
    expect(() => addMotionKeyframe(clip, 2000, 30)).toThrow("32");
    expect(addMotionKeyframe(clip, 0, 30, { x: 0.8 }).keyframes).toHaveLength(32);
  });
});

describe("gesture recording", () => {
  it("maps gesture elapsed time onto clip duration, grid-snaps, simplifies corners and preserves other fields", () => {
    const clip = { ...fixture(), keyframes: [{ ms: 500, rotate: 80, opacity: 0.4, ease: "out" as const }] };
    const input = Array.from({ length: 301 }, (_, index) => ({ elapsedMs: index * 10, x: index / 150 - 1, y: Math.sin(index / 20) * 0.8 }));
    const recorded = sampleMotionGesture(clip, input, 30);
    expect(recorded.keyframes!.length).toBeLessThanOrEqual(32);
    expect(recorded.keyframes!.length).toBeGreaterThan(3);
    expect(recorded.keyframes![0]!.ms).toBe(0); expect(recorded.keyframes!.at(-1)!.ms).toBe(2000);
    expect(recorded.keyframes!.find(frame => frame.ms === 500)).toMatchObject({ rotate: 80, opacity: 0.4, ease: "out" });
    for (const frame of recorded.keyframes!) expect(frame.ms).toBe(motionFrameMs(frame.ms, clip.durationMs, 30));
    expect(new Set(recorded.keyframes!.map(frame => frame.ms)).size).toBe(recorded.keyframes!.length);
    const { keyframes: _frames, ...staticProps } = recorded;
    const { keyframes: _original, ...expected } = clip;
    expect(staticProps).toEqual(expected); expect(clip.keyframes[0]).not.toHaveProperty("x"); projectValid(recorded);
  });
  it("retains all 32 existing timestamps and non-position properties, including off-grid data", () => {
    const clip = { ...fixture(), keyframes: Array.from({ length: 32 }, (_, index) => ({ ms: index * 59, scale: 1 + index / 32, ease: "in" as const })) };
    const next = sampleMotionGesture(clip, [{ elapsedMs: 0, x: -1, y: -1 }, { elapsedMs: 10, x: 1, y: 1 }], 29.97);
    expect(next.keyframes!.map(({ x: _x, y: _y, ...frame }) => frame)).toEqual(clip.keyframes);
    expect(next.keyframes).toHaveLength(32); projectValid(next);
  });
  it("handles short clips, duplicate gesture timestamps, extremes, empty and invalid/cancelled gestures", () => {
    expect(sampleMotionGesture(fixture(), [], 30)).toEqual(fixture());
    for (const input of [[{ elapsedMs: 0, x: 0, y: 0 }], [{ elapsedMs: 0, x: 0, y: NaN }]]) expect(() => sampleMotionGesture(fixture(), input, 30)).toThrow();
    const next = sampleMotionGesture({ ...fixture(), durationMs: 100 }, [{ elapsedMs: 0, x: -4, y: 7 }, { elapsedMs: 0, x: -2, y: 3 }, { elapsedMs: 20, x: 9, y: -6 }], 1);
    expect(next.keyframes).toEqual([{ ms: 0, x: 1, y: -1, ease: "linear" }]); projectValid(next);
  });
});
