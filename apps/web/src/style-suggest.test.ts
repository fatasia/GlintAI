import { describe, expect, it } from "vitest";
import { suggestStylePacks, type Rgb } from "./style-suggest";

const fill = (color: Rgb, count = 24): Rgb[] => Array.from({ length: count }, () => [color[0], color[1], color[2]] as Rgb);

describe("reference image style suggestions", () => {
  it("suggests dark packs for dark low-saturation references", () => {
    const suggestions = suggestStylePacks(fill([18, 18, 24]));
    expect(suggestions).toHaveLength(2);
    const names = suggestions.map(item => item.name);
    expect(names.some(name => ["glint-dark", "blackboard-tech", "blueprint", "bold-poster"].includes(name))).toBe(true);
    expect(suggestions[0]!.reason).toContain("深底");
    expect(suggestions[0]!.score).toBeLessThanOrEqual(suggestions[1]!.score);
  });

  it("suggests light packs for bright low-saturation references", () => {
    const names = suggestStylePacks(fill([246, 244, 238])).map(item => item.name);
    expect(names.some(name => ["glint-light", "cream-editorial", "mint-clean", "whiteboard", "retro-news"].includes(name))).toBe(true);
  });

  it("prefers a warm editorial pack for warm mid-tone references", () => {
    const suggestions = suggestStylePacks(fill([247, 232, 205]));
    expect(suggestions.map(item => item.name).some(name => ["cream-editorial", "retro-news", "hand-note"].includes(name))).toBe(true);
    expect(suggestions.some(item => item.reason.includes("偏暖") || item.reason.includes("明暗接近"))).toBe(true);
  });

  it("rejects empty pixel samples instead of guessing", () => {
    expect(() => suggestStylePacks([])).toThrow(/没有可用像素/);
  });
});
