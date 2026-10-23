import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { styleRhythmIssues } from "./style-rhythm";

const project = (theme: unknown, durations: number[]) => parseProject({
  schemaVersion: 1, id: "rhythm", title: "Rhythm", aspect: "16:9", theme, knowledgeSources: [],
  scenes: durations.map((durationMs, index) => ({ id: `shot-${index + 1}`, kind: "title", title: `Shot ${index + 1}`, narration: { text: `第 ${index + 1} 镜`, durationMs } })),
});

describe("style rhythm lint", () => {
  it("warns when a shot falls outside the pack's pacing range", () => {
    // bold-poster: 1800–3200ms; tolerance is 75%–125%.
    const issues = styleRhythmIssues(project("bold-poster", [2500, 6000, 800]));
    expect(issues.map(issue => issue.sceneId)).toEqual(["shot-2", "shot-3"]);
    expect(issues.every(issue => issue.rule === "style-rhythm" && issue.level === "warn")).toBe(true);
    expect(issues[0]!.message).toContain("1800–3200ms");
    expect(issues[0]!.message).toContain("6000ms");
  });

  it("stays silent inside the range and for themes or projects without a pack", () => {
    expect(styleRhythmIssues(project("bold-poster", [1800, 3200, 2400]))).toEqual([]);
    expect(styleRhythmIssues(project("custom-theme", [50]))).toEqual([]);
    expect(styleRhythmIssues(project({ fonts: "custom" }, [50]))).toEqual([]);
  });
});
