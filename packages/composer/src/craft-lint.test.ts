import { describe, expect, it } from "vitest";
import { craftLint, lintVerdict, isSlopBackground } from "./craft-lint";
import type { SceneScriptProject } from "@glintai/scenescript";
import { parseProject } from "@glintai/scenescript";

const scene = (id: string, extra: object = {}) => ({
  id, kind: "bullets", items: ["要点内容"], narration: { text: "这一镜的讲述内容足够长" }, ...extra,
});

const projectOf = (scenes: object[], extra: object = {}): SceneScriptProject =>
  parseProject({
    schemaVersion: 1, id: "lint-demo", title: "lint", aspect: "16:9",
    knowledgeSources: [], scenes, ...extra,
  } as object);

describe("craftLint", () => {
  it("passes a healthy varied project green", () => {
    const project = projectOf([
      { id: "open", kind: "title", title: "标题", narration: { text: "开场介绍这次要讲的东西" } },
      scene("body", { transition: { in: "wipe" } }),
      { id: "chart", kind: "chart", chartType: "bar", heading: "趋势", narration: { text: "图表展示趋势" }, data: [{ label: "甲", value: 1 }] },
      scene("close"),
    ]);
    expect(craftLint(project)).toEqual([]);
    expect(lintVerdict(craftLint(project))).toBe("green");
  });

  it("flags three consecutive push cameras as an error", () => {
    const project = projectOf([scene("a"), scene("b"), scene("c")].map((s, i) => ({
      ...s, camera: { type: "push" }, transition: { in: "fade" },
    })));
    const issues = craftLint(project);
    expect(issues.filter((issue) => issue.rule === "consecutive-push")).toHaveLength(1);
    expect(lintVerdict(issues)).toBe("red");
  });

  it("tolerates two pushes but blocks the third", () => {
    const project = projectOf([
      { ...scene("a"), camera: { type: "push" } },
      { ...scene("b"), camera: { type: "push" } },
      scene("c"),
    ]);
    expect(craftLint(project)).toEqual([]);
  });

  it("flags a title-card ending", () => {
    const project = projectOf([scene("a"), { id: "end-card", kind: "title", title: "谢谢", narration: { text: "感谢观看这段讲解" } }]);
    expect(craftLint(project).some((issue) => issue.rule === "card-ending")).toBe(true);
  });

  it("flags repeated transitions across three scenes", () => {
    const project = projectOf([scene("a"), scene("b"), scene("c")].map((s) => ({ ...s, transition: { in: "slide-left" } })));
    expect(craftLint(project).some((issue) => issue.rule === "same-transition")).toBe(true);
  });

  it("flags slide-deck shape and long/short narration", () => {
    const bullets = Array.from({ length: 4 }, (_, i) => scene(`s${i}`));
    const project = projectOf(bullets);
    expect(craftLint(project).some((issue) => issue.rule === "slide-deck-shape")).toBe(true);

    const withShort = projectOf([{ id: "thin", kind: "quote", text: "短", narration: { text: "空" } }]);
    expect(craftLint(withShort).some((issue) => issue.rule === "empty-content")).toBe(true);

    const withLong = projectOf([{ id: "dense", kind: "quote", text: "长", narration: { text: "字".repeat(240) } }]);
    expect(craftLint(withLong).some((issue) => issue.rule === "long-scene")).toBe(true);
  });

  it("detects blue-purple slop backgrounds in inline overrides", () => {
    const project = projectOf([scene("a")], { theme: { colors: { bg: "#7c5cff" } } });
    expect(craftLint(project).some((issue) => issue.rule === "slop-background")).toBe(true);
  });

  it("flags unlabeled dense charts", () => {
    const data = Array.from({ length: 14 }, (_, i) => ({ label: `项${i}`, value: i }));
    const project = projectOf([{ id: "dense-chart", kind: "chart", chartType: "bar", narration: { text: "很多数据点" }, data }]);
    expect(craftLint(project).some((issue) => issue.rule === "chart-unlabeled")).toBe(true);
  });
});

describe("isSlopBackground", () => {
  it("matches saturated blue-purple and rejects other colors", () => {
    expect(isSlopBackground("#7c5cff")).toBe(true);
    expect(isSlopBackground("#5c7cff")).toBe(true);
    expect(isSlopBackground("#0e9f77")).toBe(false); // mint green
    expect(isSlopBackground("#12335e")).toBe(false); // navy (dark, low sat feel)
    expect(isSlopBackground("#f6f1e3")).toBe(false); // paper
    expect(isSlopBackground("not-a-color")).toBe(false);
  });
});
