import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { blindMetrics, blindCompare, scoreDistribution } from "./blind";

const make = (overrides: { scenes?: number; filler?: boolean; repeat?: boolean } = {}) => parseProject({
  schemaVersion: 1, id: "blind", title: "盲评样例", aspect: "16:9", knowledgeSources: [],
  scenes: Array.from({ length: overrides.scenes ?? 3 }, (_, index) => ({
    id: `s${index + 1}`,
    kind: "bullets" as const,
    heading: `第 ${index + 1} 节`,
    items: ["要点一", "要点二"],
    narration: { text: overrides.repeat && index > 0 ? "同样的句子。" : overrides.filler ? "其实呢，大家可能不知道，这个点非常有意思。" : `第 ${index + 1} 节讲清楚一个概念，给出一个可验证的例子。`, durationMs: 4000 },
  })),
});

describe("blind review metrics (QA-02)", () => {
  it("scores structural and craft metrics without identity", () => {
    const clean = blindMetrics(make());
    expect(clean).toMatchObject({ scenes: 3, totalSeconds: 12, repeatedRatio: 0 });
    expect(clean.charsPerSecond).toBeGreaterThan(0);
    expect(typeof clean.lintVerdict).toBe("string");
    const metricsJson = JSON.stringify(clean);
    expect(metricsJson).not.toContain("盲评样例");
    expect(metricsJson).not.toContain("blind");
    expect(blindMetrics(make({ filler: true })).reviewFlags).toBeGreaterThanOrEqual(clean.reviewFlags);
    expect(blindMetrics(make({ repeat: true })).repeatedRatio).toBeGreaterThan(0);
  });
  it("compares A/B per metric with a summary, preferring the cleaner cut", () => {
    const { rows, summary } = blindCompare(blindMetrics(make()), blindMetrics(make({ filler: true, repeat: true })));
    expect(rows.find(row => row.metric === "重复率")!.winner).toBe("A");
    expect(rows.find(row => row.metric === "重复率")!.B).toBeGreaterThan(0);
    expect(summary).toContain("A 领先");
    const tied = blindCompare(blindMetrics(make()), blindMetrics(make()));
    expect(tied.summary).toContain("平手");
  });
  it("builds a min/median/max distribution across a batch", () => {
    const distribution = scoreDistribution([make(), make({ filler: true }), make({ scenes: 5 })]);
    expect(distribution.count).toBe(3);
    const scenes = distribution.metrics.find(metric => metric.metric === "镜头数")!;
    expect(scenes).toEqual({ metric: "镜头数", min: 3, median: 3, max: 5 });
  });
});
