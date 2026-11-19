import { describe, expect, it } from "vitest";
import { parseBrandPack, brandTheme, brandContrastIssues, contrastRatio } from "./brand";
import { themes, tokensToCssVariables } from "./index";

const good = { name: "山茶品牌", logoText: "山茶", colors: { accent: "#e0533d", bg: "#1a1214", text: "#fff5f0" } };

describe("brand kit (W5 TEAM-01)", () => {
  it("parses a valid pack and rejects bad colors without throwing", () => {
    const { pack, issues } = parseBrandPack(good);
    expect(issues).toEqual([]);
    expect(pack).toMatchObject({ name: "山茶品牌", colors: { accent: "#e0533d" } });
    expect(parseBrandPack({ name: "x", colors: { accent: "red" } }).issues.join()).toContain("#RRGGBB");
    expect(parseBrandPack({ colors: { accent: "#ffffff" } }).issues.join()).toContain("缺少品牌名");
  });
  it("merges over an installed theme, keeping untouched tokens", () => {
    const { theme } = brandTheme("glint-dark", parseBrandPack(good).pack!);
    expect(theme.colors.accent).toBe("#e0533d");
    expect(theme.colors.bg).toBe("#1a1214");
    expect(theme.fonts).toEqual(themes["glint-dark"].fonts);
    expect(theme.fontSizes).toEqual(themes["glint-dark"].fontSizes);
    // Brand themes flow through the same CSS-variable pipeline as stock themes.
    expect(tokensToCssVariables(theme)).toContain("#e0533d");
  });
  it("flags AA contrast failures and passes a legible brand", () => {
    const failing = parseBrandPack({ name: "低对比", colors: { accent: "#e0533d", bg: "#f5f5f5", text: "#eeeeee" } }).pack!;
    const issues = brandContrastIssues(failing);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join()).toContain("低于 AA");
    expect(brandContrastIssues(parseBrandPack(good).pack!)).toEqual([]);
  });
  it("computes WCAG ratios against known anchors", () => {
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  });
});
