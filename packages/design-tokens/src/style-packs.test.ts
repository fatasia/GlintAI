import { describe, expect, it } from "vitest";
import { resolveTheme, STYLE_PACKS, THEME_NAMES, themes } from "./index";

describe("style packs", () => {
  it("registers every named theme with metadata", () => {
    expect(STYLE_PACKS.map((pack) => pack.name)).toEqual([...THEME_NAMES]);
    for (const pack of STYLE_PACKS) {
      expect(pack.label.length).toBeGreaterThan(1);
      expect(pack.summary.length).toBeGreaterThan(4);
      expect(pack.rules.length).toBeGreaterThan(0);
    }
  });

  it("resolves the five new packs with distinct palettes", () => {
    const packs = ["hand-note", "retro-news", "blackboard-tech", "whiteboard", "blueprint"];
    const backgrounds = new Set(packs.map((name) => themes[name as keyof typeof themes].colors.bg));
    expect(backgrounds.size).toBe(packs.length);
    for (const name of packs) {
      const tokens = resolveTheme(name);
      expect(tokens.colors.accent).toMatch(/^#/);
      expect(tokens.fontSizes.body).toBeGreaterThan(20);
    }
  });

  it("keeps unknown-theme errors listing every pack", () => {
    expect(() => resolveTheme("nope")).toThrow(THEME_NAMES.join(", "));
  });

  it("avoids saturated blue-purple defaults across packs (craft red line)", () => {
    // blueprint is a navy engineering medium — dark desaturated base is fine;
    // what we forbid is a bright violet/indigo default background.
    for (const pack of THEME_NAMES) {
      const bg = themes[pack].colors.bg;
      const value = bg.replace("#", "");
      const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      let hue = 0;
      const delta = max - min;
      if (delta > 0) {
        if (max === r) hue = (60 * (((g - b) / delta) % 6) + 360) % 360;
        else if (max === g) hue = 60 * ((b - r) / delta + 2);
        else hue = 60 * ((r - g) / delta + 4);
      }
      const isSlop = saturation > 0.35 && max / 255 > 0.15 && hue >= 230 && hue <= 300;
      expect(isSlop).toBe(false);
    }
  });
});
