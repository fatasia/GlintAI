import { describe, expect, it } from "vitest";
import { nleAddTrack, nleClipSourceEndMs, nleDurationMs, nleMoveClip, nleRemoveClip, nleRemoveTrack, nleSampleMotion, nleSnap, nleSnapPoints, nleSplitClip, nleTransitionProgress, nleTrimClip, parseNleProject } from "./nle";

const base = {
  schemaVersion: 1 as const, id: "nle-test", title: "NLE", fps: 30, width: 1920, height: 1080,
  tracks: [
    { id: "v1", kind: "video" as const, name: "主画面", clips: [
      { id: "clip-a", kind: "video" as const, src: "assets/a.mp4", startMs: 1000, durationMs: 4000, trimStartMs: 2000, speed: 2, volume: 0.8 },
    ] },
    { id: "a1", kind: "audio" as const, name: "音乐", clips: [
      { id: "music", kind: "audio" as const, src: "assets/music.mp3", startMs: 0, durationMs: 8000, volume: 0.2 },
    ] },
  ],
};
const project = parseNleProject(base);

describe("NLE contract", () => {
  it("derives duration and source end", () => {
    expect(nleDurationMs(project)).toBe(8000);
    expect(nleClipSourceEndMs(project.tracks[0]!.clips[0]! as never)).toBe(10000);
  });
  it("rejects a clip kind on the wrong track", () => {
    expect(() => parseNleProject({ ...base, tracks: [{ ...base.tracks[1]!, clips: [{ ...base.tracks[0]!.clips[0]!, id: "bad" }] }] })).toThrow(/not allowed/);
  });
  it("trims the left edge and keeps the source in-point in sync", () => {
    const next = nleTrimClip(project, "v1", "clip-a", "start", 500);
    expect(next.tracks[0]!.clips[0]).toMatchObject({ startMs: 1500, durationMs: 3500, trimStartMs: 3000 });
  });
  it("extends and clamps the right edge", () => {
    expect(nleTrimClip(project, "v1", "clip-a", "end", 1000).tracks[0]!.clips[0]!.durationMs).toBe(5000);
    expect(nleTrimClip(project, "v1", "clip-a", "end", -99999).tracks[0]!.clips[0]!.durationMs).toBe(100);
  });
  it("splits at a timeline position and preserves the right source offset", () => {
    const next = nleSplitClip(project, "v1", "clip-a", 2500);
    const [left, right] = next.tracks[0]!.clips;
    expect(left).toMatchObject({ startMs: 1000, durationMs: 1500, trimStartMs: 2000 });
    expect(right).toMatchObject({ startMs: 2500, durationMs: 2500, trimStartMs: 5000 });
    expect(nleClipSourceEndMs(right! as never)).toBe(10000);
  });
  it("refuses a split at the very edge", () => {
    expect(nleSplitClip(project, "v1", "clip-a", 1000)).toBe(project);
  });
  it("moves without going negative and removes a clip", () => {
    expect(nleMoveClip(project, "v1", "clip-a", -50).tracks[0]!.clips[0]!.startMs).toBe(0);
    expect(nleRemoveClip(project, "v1", "clip-a").tracks[0]!.clips).toEqual([]);
  });
});

describe("NLE transitions and snapping", () => {
  it("accepts edge transitions and rejects unknown types", () => {
    const next = parseNleProject({ ...base, tracks: [{ ...base.tracks[0]!, clips: [{ ...base.tracks[0]!.clips[0]!, transitionIn: { type: "fade", durationMs: 400 }, transitionOut: { type: "wipe" } }] }, base.tracks[1]!] });
    expect(next.tracks[0]!.clips[0]).toMatchObject({ transitionIn: { type: "fade", durationMs: 400 }, transitionOut: { type: "wipe" } });
    expect(() => parseNleProject({ ...base, tracks: [{ ...base.tracks[0]!, clips: [{ ...base.tracks[0]!.clips[0]!, transitionIn: { type: "glitch" } }] }, base.tracks[1]!] })).toThrow();
  });
  it("ramps in and out inside the clip window", () => {
    const clip = { durationMs: 1000, transitionIn: { type: "fade" as const, durationMs: 400 } };
    expect(nleTransitionProgress(clip, 0, "in")).toBe(0);
    expect(nleTransitionProgress(clip, 200, "in")).toBe(0.5);
    expect(nleTransitionProgress(clip, 500, "in")).toBe(1);
    expect(nleTransitionProgress(clip, 500, "out")).toBeNull();
    expect(nleTransitionProgress({ durationMs: 1000, transitionOut: { type: "zoom" as const } }, 750, "out")).toBe(0.5);
  });
  it("collects snap points without the dragged clips and snaps to the nearest", () => {
    const points = nleSnapPoints(project, { playheadMs: 3000, excludeClipIds: ["clip-a"] });
    expect(points).toContain(3000);
    expect(points).toContain(8000);
    expect(points).not.toContain(1000);
    expect(nleSnap(2960, points, 100)).toBe(3000);
    expect(nleSnap(2800, points, 100)).toBeNull();
  });
});

describe("track add/remove", () => {
  it("appends a track with a fresh generated id and enforces the cap", () => {
    const next = nleAddTrack(project, "video");
    expect(next.tracks).toHaveLength(3);
    // v1 is taken by the base project, so the fresh track gets the next free id.
    expect(next.tracks[2]).toMatchObject({ id: "v2", kind: "video", name: "V2" });
    let current = next;
    for (let index = 0; index < 5; index++) current = nleAddTrack(current, "overlay");
    expect(current.tracks).toHaveLength(8);
    expect(() => nleAddTrack(current, "text")).toThrow(/8/);
  });
  it("removes a track with its clips and ignores unknown ids", () => {
    const next = nleRemoveTrack(project, "a1");
    expect(next.tracks.map(track => track.id)).toEqual(["v1"]);
    expect(nleRemoveTrack(project, "missing")).toBe(project);
  });
});

describe("keyframes, blend and mask", () => {
  const kfClip = {
    keyframes: [
      { ms: 0, opacity: 0, scale: 0.8, ease: "out" as const },
      { ms: 1000, opacity: 1, scale: 1.2 },
      { ms: 3000, scale: 1 },
    ],
  };
  it("interpolates each animated field independently with easing", () => {
    expect(nleSampleMotion(kfClip, 0)).toMatchObject({ opacity: 0, scale: 0.8, rotate: 0 });
    // ease "out" on the entering segment: 60% of the way lands above linear.
    const at600 = nleSampleMotion(kfClip, 600);
    expect(at600.opacity).toBeCloseTo(0.936, 2);
    expect(at600.scale).toBeGreaterThan(1.0);
    expect(nleSampleMotion(kfClip, 1000)).toMatchObject({ opacity: 1, scale: 1.2 });
    // Between 1000 and 3000 only scale is animated; opacity holds its last value.
    const at2000 = nleSampleMotion(kfClip, 2000);
    expect(at2000.opacity).toBe(1);
    expect(at2000.scale).toBeCloseTo(1.1, 5);
    // Clamped outside the sampled range; never-keyframed fields stay static.
    expect(nleSampleMotion(kfClip, 3500).scale).toBe(1);
    expect(nleSampleMotion({}, 500)).toMatchObject({ x: 0, scale: 1, opacity: 1 });
  });
  it("accepts blend and mask and rejects bad keyframe order", () => {
    const next = parseNleProject({ ...base, tracks: [
      { ...base.tracks[0]!, clips: [{ ...base.tracks[0]!.clips[0]!, blend: "screen", mask: { shape: "circle", feather: 0.2 } }] },
      base.tracks[1]!,
    ] });
    expect(next.tracks[0]!.clips[0]).toMatchObject({ blend: "screen", mask: { shape: "circle", feather: 0.2 } });
    expect(() => parseNleProject({ ...base, tracks: [{ ...base.tracks[0]!, clips: [{ ...base.tracks[0]!.clips[0]!, keyframes: [{ ms: 500, opacity: 1 }, { ms: 500, opacity: 0.5 }] }] }, base.tracks[1]!] })).toThrow(/ascending/);
  });
});
