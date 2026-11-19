import { describe, expect, it } from "vitest";
import { VideoPlan } from "./plan";
import { deriveLanguageVariant } from "./multilang";

const plan = () => VideoPlan.parse({
  title: "产品发布",
  hook: "先看产品",
  audience: "设计师",
  platform: "9:16",
  theme: "bold-poster",
  totalSeconds: 6,
  takeaway: "体验产品",
  scenes: [
    { goal: "开场", narration: "大家好，这是新产品。", visual: "产品特写", seconds: 3, kind: "title" },
    { goal: "卖点", narration: "一键生成，省时一半。", visual: "操作画面", seconds: 3, kind: "bullets" },
  ],
});

describe("TEAM-05 language variant", () => {
  it("derives a translated copy with a language tag and translated narrations", () => {
    const variant = deriveLanguageVariant(plan(), "en", { 0: "Hi, this is the new product." });
    expect(variant.language).toBe("en");
    expect(variant.scenes[0]!.narration).toBe("Hi, this is the new product.");
    expect(variant.scenes[1]!.narration).toBe("一键生成，省时一半。");
    expect(variant.totalSeconds).toBe(plan().totalSeconds);
    expect(variant.scenes[0]!.seconds).toBe(3);
  });
  it("leaves the source plan untouched", () => {
    const source = plan();
    deriveLanguageVariant(source, "pt-BR", { 0: "Olá" });
    expect(source.scenes[0]!.narration).toBe("大家好，这是新产品。");
    expect(source.language).toBeUndefined();
  });
  it("rejects bad language codes and out-of-range scene indexes", () => {
    expect(() => deriveLanguageVariant(plan(), "e", {})).toThrow(/语言代码/);
    expect(() => deriveLanguageVariant(plan(), "en", { 5: "x" })).toThrow(/镜头序号/);
  });
});
