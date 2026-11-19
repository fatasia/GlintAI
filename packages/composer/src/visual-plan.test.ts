import { describe, expect, it } from "vitest";
import { planVisuals, describeVisualPlan, VisualPlanScene } from "./visual-plan";
import type { PlanScene } from "./plan";

const scene = (overrides: Partial<PlanScene> = {}): PlanScene => ({
  goal: "讲解要点", narration: "这是要点。", visual: "一张要点卡片", seconds: 5, kind: "bullets", ...overrides,
});

describe("visual planner (CREATE-08)", () => {
  it("maps kinds to graphic relations deterministically", () => {
    const plan = planVisuals([
      scene({ kind: "title" }), scene({ kind: "comparison", visual: "两种方案对比" }),
      scene({ kind: "diagram" }), scene({ kind: "chart" }), scene({ kind: "quote" }),
    ]);
    expect(plan.map(item => item.relation)).toEqual(["none", "compare", "flow", "hierarchy", "none"]);
    expect(planVisuals([{ ...scene({ kind: "diagram" }) }])).toEqual(planVisuals([{ ...scene({ kind: "diagram" }) }]));
    expect(() => VisualPlanScene.parse(plan[0])).not.toThrow();
  });
  it("recovers relations from bullet text when the kind is generic", () => {
    const plan = planVisuals([
      scene({ visual: "方案A 与方案B 的差异" }),
      scene({ visual: "第一步准备，然后组装，最后验收" }),
      scene({ narration: "因为温度升高，导致材料膨胀" }),
      scene({ visual: "1998年立项，发展历程回顾" }),
    ]);
    expect(plan.map(item => item.relation)).toEqual(["compare", "flow", "cause-effect", "timeline"]);
  });
  it("picks layouts from relation and point count, alternating compare sides", () => {
    const plan = planVisuals([
      scene({ kind: "comparison" }), scene({ kind: "comparison" }),
      scene({ visual: "要点一；要点二；要点三；要点四" }),
      scene({ visual: "一个要点" }), scene({ kind: "title" }), scene({ kind: "chart" }),
    ]);
    expect(plan.map(item => item.layout)).toEqual(["split-left", "split-right", "grid-3", "grid-2", "center-stack", "split-right"]);
  });
  it("assigns motions: hook zoom-in, closing zoom-out, long shots pan, quotes static", () => {
    const plan = planVisuals([
      scene({ kind: "title", seconds: 3 }), scene({ seconds: 9 }), scene({ kind: "quote" }), scene({ seconds: 5 }),
    ]);
    expect(plan.map(item => item.motion)).toEqual(["zoom-in", "pan-left", "static", "zoom-out"]);
  });
  it("summarizes the relation mix and carries a rationale per scene", () => {
    const plan = planVisuals([scene({ kind: "comparison" }), scene(), scene()]);
    expect(describeVisualPlan(plan)).toContain("对比关系×1");
    for (const item of plan) expect(item.reason).toMatch(/分屏|栏|居中|全屏/);
    expect(describeVisualPlan([])).toBe("无规划场景");
  });
  it("lets user-edited layout/relation/motion win over the derivation", () => {
    const plan = planVisuals([scene({ kind: "bullets", layout: "full", relation: "timeline", motion: "zoom-out" })]);
    expect(plan[0]).toMatchObject({ layout: "full", relation: "timeline", motion: "zoom-out" });
    // Unspecified fields still derive; a partial override keeps the rest.
    const partial = planVisuals([scene({ kind: "comparison", motion: "pan-left" })]);
    expect(partial[0]).toMatchObject({ relation: "compare", motion: "pan-left" });
  });
});
