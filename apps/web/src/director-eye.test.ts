import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { reviewProject } from "./director-eye";

const build = (scenes: unknown[], extra: Record<string, unknown> = {}) => parseProject({
  schemaVersion: 1, id: "review", title: "审片样本", aspect: "16:9", knowledgeSources: [], scenes, ...extra,
});

const bullets = (id: string, durationMs: number, text = "一句旁白") => ({ id, kind: "bullets", items: ["要点一", "要点二"], narration: { text, durationMs } });

describe("director's eye", () => {
  it("flags a deck of equal, text-only cards", () => {
    const project = build([bullets("one", 3000), bullets("two", 3000), bullets("three", 3000), bullets("four", 3000)]);
    const report = reviewProject(project);
    const ids = report.findings.map(finding => finding.id);
    expect(ids).toContain("text-only");
    expect(ids).toContain("monotone-run");
    expect(ids).toContain("flat-pacing");
    expect(report.score).toBeLessThan(70);
    expect(report.verdict).not.toBe("可以给人看");
    expect(report.stats.textOnly).toBe(4);
    expect(report.stats.longestRun).toBe(4);
  });

  it("passes a varied cut with real visual devices and uneven pacing", () => {
    const project = build([
      { id: "open", kind: "title", title: "开场", subtitle: "一句话说明", camera: { type: "push", intensity: 0.4 }, narration: { text: "开场", durationMs: 2000 } },
      { id: "data", kind: "chart", chartType: "bar", data: [{ label: "A", value: 12 }], camera: { type: "push" }, narration: { text: "数据", durationMs: 5000 } },
      { id: "flow", kind: "diagram", steps: [{ label: "一" }, { label: "二" }], camera: { type: "pan-left" }, narration: { text: "流程", durationMs: 7000 } },
      { id: "close", kind: "bullets", items: ["结论"], elements: [{ id: "e1", kind: "text", text: "结论", x: 0.1, y: 0.2, fontSize: 32, color: "#ffffff" }], camera: { type: "pull" }, narration: { text: "收束", durationMs: 3000 } },
    ], { knowledgeSources: [{ id: "src", kind: "markdown", name: "source.md" }] });
    const report = reviewProject(project);
    const ids = report.findings.map(finding => finding.id);
    expect(ids).not.toContain("text-only");
    expect(ids).not.toContain("flat-pacing");
    expect(ids).not.toContain("no-motion");
    expect(ids).not.toContain("numbers-without-source");
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.verdict).toBe("可以给人看");
  });

  it("warns about charts without a source and long narration for portrait", () => {
    const project = build([
      { id: "chart", kind: "chart", chartType: "bar", data: [{ label: "A", value: 1 }], narration: { text: "数据", durationMs: 4000 } },
      { id: "talk", kind: "bullets", items: ["一"], narration: { text: "这".repeat(120), durationMs: 5000 } },
      { id: "end", kind: "title", title: "结尾", narration: { text: "完", durationMs: 3000 } },
    ]);
    const ids = reviewProject(project).findings.map(finding => finding.id);
    expect(ids).toContain("numbers-without-source");
    expect(ids).toContain("portrait-readability");
    expect(ids).toContain("card-ending");
  });
});
