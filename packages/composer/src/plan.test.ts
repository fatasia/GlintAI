import { describe, expect, it } from "vitest";
import { PLAN_SYSTEM, parsePlanReply, planToSource } from "./plan";
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

describe("parsePlanReply enum recovery (real-model finding 2026-10-23)", () => {
  const base = parsePlanReply(reply);
  it("recovers decorated platform enums instead of failing the paid call", () => {
    // deepseek-v4.1-flash returned "16:9 短视频平台" over the media gateway.
    expect(parsePlanReply(JSON.stringify({ ...base, platform: "16:9 短视频平台" })).platform).toBe("16:9");
    expect(parsePlanReply(JSON.stringify({ ...base, platform: "竖屏 9:16 抖音" })).platform).toBe("9:16");
    expect(parsePlanReply(JSON.stringify({ ...base, platform: "方形 1:1" })).platform).toBe("1:1");
  });
  it("still rejects values with no recognizable ratio", () => {
    expect(() => parsePlanReply(JSON.stringify({ ...base, platform: "电影院宽幅" }))).toThrow();
  });
  it("keeps the diversity and strict-enum rules in the planning prompt", () => {
    expect(PLAN_SYSTEM).toContain("不许默认 bullets");
    expect(PLAN_SYSTEM).toContain("platform 字段只能输出");
  });
});

describe("budget field (CREATE-02)", () => {
  const base = parsePlanReply(reply);
  it("accepts an optional budgetCny and keeps it on the parsed plan", () => {
    const plan = parsePlanReply(JSON.stringify({ ...base, budgetCny: 500 }));
    expect(plan.budgetCny).toBe(500);
  });
  it("omits budgetCny when the model does not return one", () => {
    expect("budgetCny" in parsePlanReply(reply)).toBe(false);
  });
  it("renders the budget into composer markdown as an advisory constraint", () => {
    const source = planToSource(parsePlanReply(JSON.stringify({ ...base, budgetCny: 500 })));
    expect(source).toContain("制作预算参考：500元");
  });
  it("keeps the advisory-budget rule in the planning prompt", () => {
    expect(PLAN_SYSTEM).toContain("budgetCny");
    expect(PLAN_SYSTEM).toContain("不编造精确报价");
  });
});
