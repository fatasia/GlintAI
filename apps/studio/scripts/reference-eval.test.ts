import { describe, expect, it } from "vitest";
import { evaluationOptions, evaluationThreshold, matchCuts, scoreOcrFrame, summarizeOcrFrames, targetDistance, validateManifest } from "./reference-eval";

describe("reference evaluation", () => {
  it("accepts an explicit evaluation threshold without silently accepting malformed options", () => {
    expect(evaluationThreshold([])).toBeUndefined();
    expect(evaluationThreshold(["--threshold=0.04"])).toBe(0.04);
    expect(evaluationThreshold(["--threshold=0"])).toBe(0);
    expect(evaluationThreshold(["--threshold=1.0"])).toBe(1);
    for (const args of [["--threshold="], ["--threshold=NaN"], ["--threshold=1.01"], ["--threshold=-1"], ["--other=0.04"], ["--threshold=0", "--threshold=1"]]) expect(() => evaluationThreshold(args)).toThrow(/Usage/);
  });
  it("accepts cuts-only in either order and rejects duplicate or unknown options", () => {
    expect(evaluationOptions([])).toEqual({ threshold: undefined, cutsOnly: false });
    expect(evaluationOptions(["--cuts-only", "--threshold=0.04"])).toEqual({ threshold: 0.04, cutsOnly: true });
    expect(evaluationOptions(["--threshold=0.04", "--cuts-only"])).toEqual({ threshold: 0.04, cutsOnly: true });
    for (const args of [["--cuts-only", "--cuts-only"], ["--cuts-only", "--other"], ["--threshold=0", "--threshold=1"]]) expect(() => evaluationOptions(args)).toThrow(/Usage/);
  });
  it("matches cuts one-to-one within tolerance, maximizing matches before minimizing time error", () => {
    expect(matchCuts([100, 200], [60, 130], 70)).toEqual({ pairs: [[100, 60], [200, 130]], tp: 2, fp: 0, fn: 0, absoluteErrorMs: 110 });
    expect(matchCuts([100], [90, 101], 20)).toEqual({ pairs: [[100, 101]], tp: 1, fp: 1, fn: 0, absoluteErrorMs: 1 });
    expect(matchCuts([100], [201], 100)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(matchCuts([], [], 0)).toMatchObject({ tp: 0, fp: 0, fn: 0 });
  });
  it("rejects invalid or duplicated cut inputs", () => {
    for (const args of [[[1, 1], [], 1], [[], [3, 2], 1], [[NaN], [], 1], [[], [], -1]] as [number[], number[], number][]) expect(() => matchCuts(...args)).toThrow();
  });
  it("rejects ambiguous datasets, duplicate IDs, invalid annotations and OCR truncation", () => {
    const item = { id: "sample", path: "sample.mp4", sha256: "a".repeat(64), cutsMs: [100], frames: [{ atMs: 20, targets: ["text"] }] };
    const valid = { version: 1, datasetKind: "synthetic-rendered", cases: [item] };
    expect(() => validateManifest(valid)).not.toThrow();
    expect(() => validateManifest({ ...valid, datasetKind: "real" })).toThrow();
    expect(() => validateManifest({ ...valid, cases: [item, item] })).toThrow();
    expect(() => validateManifest({ ...valid, cases: [{ ...item, frames: Array(13).fill(item.frames[0]) }] })).toThrow();
    expect(() => validateManifest({ ...valid, cases: [{ ...item, cutsMs: [4, 4] }] })).toThrow();
    expect(() => validateManifest({ ...valid, cases: [{ ...item, frames: [{ atMs: 0, targets: ["!!!"] }] }] })).toThrow();
    expect(() => validateManifest({ ...valid, cases: [{ ...item, id: "../escape" }] })).toThrow();
  });
  it("requires explicit complete no-text annotations and counts any returned line as a frame false positive", () => {
    const item = { id: "negative", path: "sample.mp4", sha256: "a".repeat(64), cutsMs: [], frames: [{ atMs: 0, targets: [], noText: true }] };
    const dataset = { version: 1, datasetKind: "synthetic-rendered", cases: [item] };
    expect(() => validateManifest(dataset)).not.toThrow();
    for (const frame of [{ atMs: 0, targets: [] }, { atMs: 0, targets: [], noText: false }, { atMs: 0, targets: ["text"], noText: true }]) {
      expect(() => validateManifest({ ...dataset, cases: [{ ...item, frames: [frame] }] })).toThrow(/Invalid annotated frame/);
    }
    expect(scoreOcrFrame(item.frames[0] as { atMs: number; targets: string[]; noText: true }, [])).toMatchObject({ noText: true, falsePositive: false, targets: [] });
    expect(scoreOcrFrame(item.frames[0] as { atMs: number; targets: string[]; noText: true }, ["幻觉"])).toMatchObject({ noText: true, falsePositive: true, recognized: ["幻觉"] });
    expect(scoreOcrFrame({ atMs: 0, targets: ["a"] }, ["a", "other"])).not.toHaveProperty("falsePositive");
    expect(summarizeOcrFrames([])).toEqual({ noTextFrames: 0, falsePositiveFrames: 0, noTextFrameFalsePositiveRate: null });
    const negative = { atMs: 0, targets: [], noText: true as const };
    expect(summarizeOcrFrames([scoreOcrFrame(negative, []), scoreOcrFrame(negative, ["x", "y"]), scoreOcrFrame({ atMs: 1, targets: ["a"] }, ["other"])]))
      .toEqual({ noTextFrames: 2, falsePositiveFrames: 1, noTextFrameFalsePositiveRate: 0.5 });
  });
  it("scores target substrings separately from unlabelled words and treats missing output as deletions", () => {
    expect(targetDistance("缓存命中", ["标题：缓存 命中！"]).distance).toBe(0);
    expect(targetDistance("中文测试", ["中文识别"])).toEqual({ distance: 2, length: 4, exact: false });
    expect(targetDistance("abc", [])).toEqual({ distance: 3, length: 3, exact: false });
    expect(targetDistance("🙂A", ["a"])).toEqual({ distance: 0, length: 1, exact: true });
    expect(() => targetDistance("？！", [])).toThrow();
  });
});
