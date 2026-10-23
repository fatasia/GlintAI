import { describe, expect, it } from "vitest";
import { parsePlanReply, planToSource } from "./plan";
const reply = `好的，这是计划：
\`\`\`json
{"title":"一杯咖啡讲熵","hook":"热咖啡为什么会凉？","audience":"零基础观众","platform":"16:9","theme":"glint-dark","totalSeconds":15,"takeaway":"熵只增不减","scenes":[{"goal":"抛出问题","narration":"热咖啡为什么会凉？","visual":"热咖啡特写，热气上升","seconds":3,"kind":"title"},{"goal":"给出定义","narration":"熵是微观排列方式的数量。","visual":"咖啡与牛奶混合动画","seconds":6,"kind":"definition"}]}
\`\`\``;
describe("video plan", () => {
  it("parses a fenced JSON reply and clamps nothing silently", () => {
    const plan = parsePlanReply(reply);
    expect(plan.title).toBe("一杯咖啡讲熵");
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes[0]).toMatchObject({ kind: "title", seconds: 3 });
  });
  it("rejects prose without JSON", () => {
    expect(() => parsePlanReply("我觉得做不了")).toThrow(/JSON/);
  });
  it("renders an approved plan into composer-ready markdown", () => {
    const source = planToSource(parsePlanReply(reply));
    expect(source).toContain("# 一杯咖啡讲熵");
    expect(source).toContain("## 给出定义");
    expect(source).toContain("画面：咖啡与牛奶混合动画");
  });
});
