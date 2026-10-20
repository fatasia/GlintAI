import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  resolveTheme,
  themes,
  tokensToCssVariables,
} from "./index";

describe("resolveTheme", () => {
  it("returns the default theme when nothing is passed", () => {
    expect(resolveTheme()).toBe(themes[DEFAULT_THEME]);
  });

  it("resolves a named theme", () => {
    expect(resolveTheme("glint-light").colors.bg).toBe("#faf9fc");
  });

  it("throws a listing error for unknown names", () => {
    expect(() => resolveTheme("nope")).toThrow(/Available themes/);
  });

  it("merges inline overrides over the default theme", () => {
    const t = resolveTheme({ colors: { accent: "#ff0000" }, radius: 4 });
    expect(t.colors.accent).toBe("#ff0000");
    expect(t.colors.bg).toBe(themes["glint-dark"].colors.bg);
    expect(t.radius).toBe(4);
  });

  it("ignores garbage input instead of crashing", () => {
    expect(resolveTheme(null)).toBe(themes[DEFAULT_THEME]);
    expect(resolveTheme(42 as unknown as undefined)).toBe(
      themes[DEFAULT_THEME],
    );
  });
});

describe("tokensToCssVariables", () => {
  it("emits one --glint-* declaration per token path", () => {
    const css = tokensToCssVariables(themes["glint-dark"]);
    expect(css).toContain("--glint-color-bg: #121016;");
    expect(css).toContain("--glint-font-size-body: 36px;");
    expect(css).toContain("--glint-motion-fade-ms: 420;");
    expect(css).toContain("--glint-shadow-card: 0 32px 90px rgba(10, 8, 20, 0.5);");
    expect(css).toContain("--glint-shadow-inner-highlight: inset 0 1px 1px rgba(255, 255, 255, 0.12);");
    expect(css).toContain("--glint-line-hairline: 1px solid rgba(245, 243, 247, 0.08);");
    const declarations = css
      .split("\n")
      .filter((line) => line.startsWith("--glint-"));
    // 7 colors + 3 fonts + 5 font sizes + radius + fade duration + 3 effect tokens
    expect(declarations.length).toBe(20);
  });
});
