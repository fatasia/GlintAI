import { describe, expect, it } from "vitest";
import { nleSpeedAt, nleSourceElapsedMs, nleSourceTimeMs, nleSpeedRampWindow, type SpeedClip } from "./nle-speed";

const clip = (overrides: Partial<SpeedClip> = {}): SpeedClip => ({ durationMs: 1000, speed: 1, ...overrides });

describe("speed ramp source-time mapping", () => {
  it("linear stays constant; in accelerates monotonically; out mirrors; bell is slow-fast-slow", () => {
    expect(nleSpeedAt(clip(), 250)).toBe(1);
    const ramp = [0, 500, 1000].map(ms => nleSpeedAt(clip({ speedCurve: "in" }), ms));
    expect(ramp[0]).toBeLessThan(ramp[1]!); expect(ramp[1]!).toBeLessThan(ramp[2]!);
    expect(nleSpeedAt(clip({ speedCurve: "out" }), 250)).toBeCloseTo(nleSpeedAt(clip({ speedCurve: "in" }), 750), 6);
    const bell = [0, 500, 1000].map(ms => nleSpeedAt(clip({ speedCurve: "bell" }), ms));
    expect(bell[0]).toBeCloseTo(bell[2]!, 6); expect(bell[1]!).toBeGreaterThan(bell[0]!);
  });

  it("integrates speed so source time is the exact anti-derivative", () => {
    // The in/out shapes run 0.5×→1.5× and 1.5×→0.5×: both average 1×, so a full
    // 1000 ms window consumes exactly 1000 ms of source. Bell averages 1× too.
    expect(nleSourceElapsedMs(clip({ speedCurve: "in" }), 1000)).toBe(1000);
    expect(nleSourceElapsedMs(clip({ speedCurve: "out" }), 1000)).toBe(1000);
    expect(nleSourceElapsedMs(clip({ speedCurve: "bell" }), 1000)).toBeCloseTo(1000, 6);
    expect(nleSourceElapsedMs(clip(), 1000)).toBe(1000);
    // The ramp front-loads: half the window consumes 3/8 of the source (0.5→1.0 mean 0.75).
    expect(nleSourceElapsedMs(clip({ speedCurve: "in" }), 500)).toBeCloseTo(375, 6);
    // Sub-intervals sum to the whole: no double counting at the seam.
    const sum = nleSourceElapsedMs(clip({ speedCurve: "in" }), 400) + nleSourceElapsedMs(clip({ speedCurve: "in", speedRamp: { durationMs: 1000, offsetMs: 400 } }), 600);
    expect(sum).toBeCloseTo(1000, 4);
  });

  it("keeps trimStartMs as the absolute source base", () => {
    expect(nleSourceTimeMs(clip({ trimStartMs: 500, speedCurve: "in" }), 1000)).toBe(1500);
    expect(nleSourceTimeMs(clip({ trimStartMs: 500 }), 1000)).toBe(1500);
  });

  it("cuts preserve the original curve domain via windows", () => {
    expect(nleSpeedRampWindow(clip())).toBeUndefined();
    expect(nleSpeedRampWindow(clip({ speedCurve: "bell" }), 250)).toEqual({ durationMs: 1000, offsetMs: 250 });
  });

  it("consumes its own clip types without importing the NLE schema", () => {
    const partial: SpeedClip = { durationMs: 500, speed: 2 };
    expect(nleSpeedAt(partial, 250)).toBe(2);
  });
});
