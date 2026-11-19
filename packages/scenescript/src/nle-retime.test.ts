import { describe, expect, it } from "vitest";
import { nleSampleMotion, nleSplitClip, nleTrimClip, nleRollEdit, nleSourceTimeMs, parseNleProject, type NleClip } from "./nle";

const fixture = (curve: NleClip["speedCurve"] = "bell") => parseNleProject({
  schemaVersion: 1, id: "ramp", title: "Ramp", width: 320, height: 180, fps: 30,
  tracks: [{ id: "v1", kind: "video", name: "Video", clips: [
    { id: "left", kind: "video", src: "assets/one.mp4", startMs: 1000, durationMs: 4000, trimStartMs: 2000, speedCurve: curve },
    { id: "right", kind: "video", src: "assets/two.mp4", startMs: 5000, durationMs: 2000, trimStartMs: 140.3, speedCurve: curve },
  ] }],
});
const first = (project: ReturnType<typeof fixture>, index = 0) => project.tracks[0]!.clips[index]!;

for (const curve of ["in", "out", "bell"] as const) describe(`${curve} source continuity`, () => {
  it("split preserves every sample on both halves, including fractional source in-points", () => {
    const project = fixture(curve), original = first(project);
    const splitAt = 1333;
    const result = nleSplitClip(project, "v1", "left", original.startMs + splitAt);
    const left = first(result), right = first(result, 1);
    for (const local of [0, 101, 700, 1332]) expect(nleSourceTimeMs(left, local)).toBeCloseTo(nleSourceTimeMs(original, local), 8);
    for (const local of [0, 101, 700, right.durationMs]) expect(nleSourceTimeMs(right, local)).toBeCloseTo(nleSourceTimeMs(original, local + splitAt), 8);
    expect(right.speedRamp).toEqual({ durationMs: 4000, offsetMs: splitAt });
  });
  it("left and right trims preserve the original curve rather than stretching it", () => {
    const project = fixture(curve), original = first(project);
    const trimmed = first(nleTrimClip(project, "v1", "left", "start", 333));
    expect(nleSourceTimeMs(trimmed, 127)).toBeCloseTo(nleSourceTimeMs(original, 460), 8);
    const extended = first(nleTrimClip(project, "v1", "left", "end", 800));
    expect(nleSourceTimeMs(extended, 3000)).toBeCloseTo(nleSourceTimeMs(original, 3000), 8);
  });
  it("roll uses the curved right source clock and clamps the earlier-source boundary", () => {
    const project = fixture(curve), oldRight = first(project, 1);
    const moved = nleRollEdit(project, "v1", "left", 333);
    expect(nleSourceTimeMs(first(moved, 1), 700)).toBeCloseTo(nleSourceTimeMs(oldRight, 1033), 8);
    expect(nleSourceTimeMs(first(moved), 900)).toBeCloseTo(nleSourceTimeMs(first(project), 900), 8);
    const back = nleRollEdit(project, "v1", "left", -9999), right = first(back, 1);
    const delta = right.startMs - oldRight.startMs;
    expect(right.trimStartMs).toBeGreaterThanOrEqual(0);
    expect(nleSourceTimeMs(oldRight, delta - 1)).toBeLessThan(0);
    expect(nleSourceTimeMs(right, 500)).toBeCloseTo(nleSourceTimeMs(oldRight, delta + 500), 8);
  });
});

it("locked track rejects split, trim and roll at the contract boundary", () => {
  const project = fixture(); project.tracks[0]!.locked = true;
  expect(nleSplitClip(project, "v1", "left", 2000)).toBe(project);
  expect(nleTrimClip(project, "v1", "left", "start", 333)).toBe(project);
  expect(nleRollEdit(project, "v1", "left", 333)).toBe(project);
});

it("single keyframe applies its animated fields without replacing unrelated static fields", () => {
  const clip = { transform: { x: 0.2, rotate: 30 }, keyframes: [{ ms: 500, scale: 1.7, opacity: 0.4 }] };
  expect(nleSampleMotion(clip, 700)).toMatchObject({ x: 0.2, rotate: 30, scale: 1.7, opacity: 0.4 });
});
