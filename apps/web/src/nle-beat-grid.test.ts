import { expect, it } from "vitest";
import { nleSnap } from "@glintai/scenescript";
import { beatSnapCandidates, onsetSnapCandidates, calibrationToManualGrid } from "./nle-beat-grid";

it("converts a relative phase only after an explicit choice, preserving an editable grid", () => {
  const grid = calibrationToManualGrid({ bpm: 120, offsetMs: 200 }, 1000, 2)!;
  expect(grid).toEqual({ bpm: 120, offsetMs: 1200, subdivisions: 2 });
  expect(beatSnapCandidates(1440, grid)).toEqual([1200, 1450]);
  expect(calibrationToManualGrid({ bpm: 120, offsetMs: -1 }, 1000)).toBeNull();
  expect(calibrationToManualGrid({ bpm: Infinity, offsetMs: 0 }, 0)).toBeNull();
  expect(calibrationToManualGrid({ bpm: 120, offsetMs: 1 }, 21_600_000)).toBeNull();
});

it("finds neighbours for beat, half-beat and quarter-beat grids with an offset", () => {
  expect(beatSnapCandidates(620, { bpm: 120, offsetMs: 100, subdivisions: 1 })).toEqual([600, 1100]);
  expect(beatSnapCandidates(360, { bpm: 120, offsetMs: 100, subdivisions: 2 })).toEqual([350, 600]);
  expect(beatSnapCandidates(230, { bpm: 120, offsetMs: 100, subdivisions: 4 })).toEqual([225, 350]);
  expect(beatSnapCandidates(90, { bpm: 120, offsetMs: 100, subdivisions: 1 })).toEqual([100]);
});
it("preserves fractional BPM without per-beat accumulated rounding", () => {
  const grid = { bpm: 131.97, offsetMs: 224.4, subdivisions: 1 } as const;
  const exact = grid.offsetMs + 10000 * 60_000 / grid.bpm;
  expect(beatSnapCandidates(exact, grid)).toContain(Math.round(exact));
  expect(nleSnap(exact + 4, beatSnapCandidates(exact + 4, grid), 10)).toBe(Math.round(exact));
});
it("returns no candidate for invalid values and respects the six-hour bound", () => {
  expect(beatSnapCandidates(100, { bpm: 0, offsetMs: 0, subdivisions: 1 })).toEqual([]);
  expect(beatSnapCandidates(100, { bpm: 120, offsetMs: -1, subdivisions: 1 })).toEqual([]);
  expect(beatSnapCandidates(Number.NaN, { bpm: 120, offsetMs: 0, subdivisions: 1 })).toEqual([]);
  expect(beatSnapCandidates(21_600_001, { bpm: 120, offsetMs: 0, subdivisions: 1 })).toEqual([21_600_000]);
});
it("finds neighbours among the actual irregular detected onsets", () => {
  expect(onsetSnapCandidates(755, [110, 320, 710, 920])).toEqual([710, 920]);
  expect(onsetSnapCandidates(0, [110, 320])).toEqual([110]);
  expect(onsetSnapCandidates(500, [110, 320])).toEqual([320]);
  expect(onsetSnapCandidates(100, [])).toEqual([]);
});
