import { describe, expect, it } from "vitest";
import { diffFingerprints, fingerprintDistance, frameFingerprint, frameTimecode, toRanges } from "./index";

const GRID = 16;
const flat = (value: number, width = GRID, height = GRID) => new Uint8Array(width * height).fill(value);
const CELLS = GRID * GRID;

describe("frame fingerprint", () => {
  it("is deterministic and 512 hex characters wide", () => {
    const fingerprint = frameFingerprint(flat(100), GRID, GRID);
    expect(fingerprint).toMatch(/^[0-9a-f]{512}$/);
    expect(fingerprint).toBe(frameFingerprint(flat(100), GRID, GRID));
    expect(new Set(fingerprint.match(/.{2}/g))).toEqual(new Set(["64"]));
  });
  it("captures luminance changes in flat regions, not just gradients", () => {
    const dark = frameFingerprint(flat(20), GRID, GRID);
    const bright = frameFingerprint(flat(200), GRID, GRID);
    expect(fingerprintDistance(bright, dark)).toMatchObject({ changedCells: CELLS, maxAbs: 180 });
    expect(fingerprintDistance(bright, dark).meanAbs).toBeCloseTo(180, 6);
  });
  it("rejects malformed input", () => {
    expect(() => frameFingerprint(new Uint8Array(10), 2, 2)).toThrow(/16×16/);
    expect(() => frameFingerprint(new Uint8Array(400), GRID, GRID)).not.toThrow();
  });
});

describe("fingerprint distance", () => {
  it("counts only cells above the threshold", () => {
    const base = "00".repeat(CELLS);
    const noisy = `0a${"00".repeat(CELLS - 1)}`;
    expect(fingerprintDistance(noisy, base, 12).changedCells).toBe(0);
    expect(fingerprintDistance(noisy, base, 5).changedCells).toBe(1);
  });
  it("rejects mismatched or malformed fingerprints", () => {
    expect(() => fingerprintDistance("00", "0000")).toThrow(/equal-length/);
    expect(() => fingerprintDistance("zz", "00")).toThrow();
  });
});

describe("frame diff", () => {
  const same = Array.from({ length: 100 }, () => "00".repeat(CELLS));
  it("passes identical sequences", () => {
    expect(diffFingerprints(same, same)).toMatchObject({ total: 100, changed: [], ratio: 0, pass: true });
  });
  it("localises a single changed frame", () => {
    const after = [...same];
    after[50] = "ff".repeat(CELLS);
    const diff = diffFingerprints(after, same);
    expect(diff.changed).toEqual([50]);
    expect(diff.ranges).toEqual([[50, 50]]);
    expect(diff.ratio).toBeCloseTo(0.01);
    expect(diff.pass).toBe(true);
  });
  it("ignores a few changed cells but catches them when asked", () => {
    const after = [...same];
    after[10] = `ff${"00".repeat(CELLS - 1)}`;
    expect(diffFingerprints(after, same).changed).toEqual([]);
    expect(diffFingerprints(after, same, { changedCells: 0.001 }).changed).toEqual([10]);
  });
  it("fails when the changed ratio exceeds the budget", () => {
    const after = Array.from({ length: 100 }, (_, index) => (index < 10 ? "ff".repeat(CELLS) : "00".repeat(CELLS)));
    expect(diffFingerprints(after, same, { maxChangedRatio: 0.02 }).pass).toBe(false);
    expect(diffFingerprints(after, same, { maxChangedRatio: 0.2 }).pass).toBe(true);
  });
  it("treats length changes as changed frames", () => {
    const diff = diffFingerprints(same.slice(0, 90), same);
    expect(diff.lengthMismatch).toBe(true);
    expect(diff.changed).toHaveLength(10);
    expect(diff.changed[0]).toBe(90);
  });
  it("merges consecutive frames into ranges", () => {
    expect(toRanges([1, 2, 3, 7, 9, 10])).toEqual([[1, 3], [7, 7], [9, 10]]);
  });
  it("formats frame timecodes", () => {
    expect(frameTimecode(0, 30)).toBe("00:00:00.000");
    expect(frameTimecode(30, 30)).toBe("00:00:01.000");
    expect(frameTimecode(45, 30)).toBe("00:00:01.500");
  });
});
