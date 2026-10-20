import { describe, expect, it } from "vitest";
import { composeFromMarkdown } from "./heuristic";
import { TEMPLATES, isTemplateId, templateById } from "./templates";

const VERSUS_SOURCE = [
  "# 两种缓存策略",
  "",
  "## 内存缓存",
  "",
  "读取速度极快,适合会话数据。",
  "进程重启后数据全部丢失。",
  "",
  "## 分布式缓存",
  "",
  "多实例共享同一份数据。",
  "每次读取都有网络开销。",
].join("\n");

const PAPER_SOURCE = [
  "注意力机制研究",
  "",
  "## 研究背景",
  "",
  "序列模型的计算量随长度二次增长。",
  "",
  "## 方法设计",
  "",
  "引入稀疏注意力降低计算复杂度。",
  "",
  "## 实验结果",
  "",
  "长文本任务准确率提升明显。",
].join("\n");

describe("narrative templates", () => {
  it("registry is wired and type-guarded", () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual([
      "explainer",
      "listicle",
      "versus",
      "paper",
      "howto", "timeline", "faq", "mythfact", "case-study", "problem-solution", "code-walkthrough", "recap",
    ]);
    expect(isTemplateId("versus")).toBe(true);
    expect(isTemplateId("hologram")).toBe(false);
    expect(templateById("paper")?.label).toBe("论文/报告解读");
  });

  it("listicle turns every section into numbered bullet groups", () => {
    const project = composeFromMarkdown(VERSUS_SOURCE, {
      template: "listicle",
    });
    const body = project.scenes.slice(1);
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const scene of body) expect(scene.kind).toBe("bullets");
  });

  it("versus merges the first two sections into one comparison card", () => {
    const project = composeFromMarkdown(VERSUS_SOURCE, {
      template: "versus",
    });
    const comparison = project.scenes.find((scene) => scene.kind === "comparison");
    expect(comparison).toBeDefined();
    if (comparison?.kind !== "comparison") throw new Error("kind drifted");
    expect(comparison.left.label).toBe("内存缓存");
    expect(comparison.right.label).toBe("分布式缓存");
    expect(comparison.left.points.length).toBeGreaterThan(0);
  });

  it("paper lays out 问题→方法→结果 beats and a pipeline diagram", () => {
    const project = composeFromMarkdown(PAPER_SOURCE, {
      template: "paper",
    });
    const kinds = project.scenes.map((scene) => scene.kind);
    // scenes[0] is the always-present title hook; beats follow.
    expect(kinds[1]).toBe("definition");
    expect(kinds).toContain("diagram");
    const diagram = project.scenes.find((scene) => scene.kind === "diagram");
    if (diagram?.kind !== "diagram") throw new Error("diagram missing");
    expect(diagram.steps.map((step) => step.label)).toContain("方法");
  });

  it("default explainer behavior is unchanged when no template is given", () => {
    const project = composeFromMarkdown(VERSUS_SOURCE);
    expect(project.scenes.map((scene) => scene.kind)).not.toContain("comparison");
  });
});
