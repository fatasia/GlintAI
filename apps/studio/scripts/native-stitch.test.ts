import { describe, expect, it } from "vitest";
import { buildStitchPlan } from "./native-stitch";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";

const project = (durations: number[], overlaps: number[] = []) => parseProject({ schemaVersion: 1, id: "overlap", title: "叠化", aspect: "16:9", knowledgeSources: [], scenes: durations.map((durationMs, i) => ({ id: `s${i}`, kind: "title", title: String(i), narration: { text: "叠化讲解", durationMs }, ...(overlaps[i] ? { transition: { in: "fade", overlapMs: overlaps[i] } } : {}) })) });

describe("overlap timeline and stitch contract", () => {
  it("keeps the first scene at zero and subtracts one overlap exactly", () => {
    const t = buildTimeline(project([2000, 2000], [0, 500]));
    expect(t.entries.map(e => e.startMs)).toEqual([0, 1500]); expect(t.totalMs).toBe(3500);
    const { entries } = timelineToFrames(t, 30), plan = buildStitchPlan(entries, 30);
    expect(plan.totalFrames).toBe(105); expect(plan.overlaps).toEqual([0, 15]);
    expect(plan.filter).toContain("xfade=transition=fade:duration=0.5:offset=1.5");
  });
  it("uses hard concat only when there is no overlap", () => {
    const { entries } = timelineToFrames(buildTimeline(project([1500, 1500, 1500])), 24);
    const p = buildStitchPlan(entries, 24); expect(p.filter).not.toContain("xfade"); expect(p.filter).toContain("concat=n=2"); expect(p.totalFrames).toBe(108);
  });
  it("retains exact cumulative rounding for multiple fractional boundaries", () => {
    const { entries, durationInFrames } = timelineToFrames(buildTimeline(project([1234, 1567, 2101], [0, 333, 499])), 24);
    const p = buildStitchPlan(entries, 24); expect(p.totalFrames).toBe(durationInFrames); expect(p.overlaps.every(v => Number.isInteger(v) && v >= 0)).toBe(true);
  });
  it("clamps an overlap before it consumes a neighbor", () => {
    const t = buildTimeline(project([800, 800], [0, 1500])); expect(t.entries[1]!.startMs).toBe(200); expect(t.totalMs).toBe(1000);
  });
  it("rejects invalid stitching inputs", () => {
    expect(() => buildStitchPlan([], 30)).toThrow();
    expect(() => buildStitchPlan([{ from: 0, duration: 2 }], 0)).toThrow();
    expect(() => buildStitchPlan([{ from: 0, duration: 20 }, { from: 0, duration: 20 }], 30)).toThrow();
  });
});
