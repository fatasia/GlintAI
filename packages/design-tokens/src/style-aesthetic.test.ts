import { describe, expect, it } from "vitest";
import { AESTHETIC_FONTS, STYLE_PACKS, THEME_NAMES, stylePackAesthetic, themes } from "./index";

describe("style pack aesthetic layer", () => {
  it("covers every theme exactly once with a versioned recipe", () => {
    expect(STYLE_PACKS.map((pack) => pack.name)).toEqual([...THEME_NAMES]);
    for (const pack of STYLE_PACKS) {
      expect(pack.aesthetic.version).toBe(1);
      expect(pack.aesthetic.referencePreviews.length).toBeGreaterThan(0);
      expect(pack.aesthetic.referencePreviews.length).toBeLessThanOrEqual(3);
      expect(pack.aesthetic.composition.safeArea.length).toBeGreaterThan(4);
      expect(pack.aesthetic.composition.notes.length).toBeGreaterThan(4);
      expect(pack.aesthetic.motion.reducedMotion.length).toBeGreaterThan(4);
      expect(pack.aesthetic.sound.mood.length).toBeGreaterThan(2);
      expect(pack.aesthetic.pacing.cutPattern.length).toBeGreaterThan(2);
    }
  });

  it("derives type scale and entrance timing from the rendered theme", () => {
    for (const pack of STYLE_PACKS) {
      expect(pack.aesthetic.typography.scale).toEqual(themes[pack.name].fontSizes);
      expect(pack.aesthetic.motion.entranceMs).toBe(themes[pack.name].motion.fadeMs);
    }
  });

  it("names real fonts with honest licences and never embeds font bytes", () => {
    for (const pack of STYLE_PACKS) {
      const { display, body, mono } = pack.aesthetic.typography;
      for (const key of [display, body, mono]) {
        const font = AESTHETIC_FONTS[key];
        expect(font, key).toBeTruthy();
        expect(font.license === "OFL-1.1" || font.license === "system-stack").toBe(true);
        if (font.license === "system-stack") expect(font.source).toBe("system-installed");
        else expect(font.source).toMatch(/^https:\/\/github\.com\//);
      }
    }
    const serialized = JSON.stringify(STYLE_PACKS);
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("data:font");
  });

  it("keeps pacing, loudness and density inside sane ranges", () => {
    for (const pack of STYLE_PACKS) {
      const { shotMs, holdMs } = pack.aesthetic.pacing;
      expect(shotMs[0]).toBeGreaterThanOrEqual(1500);
      expect(shotMs[1]).toBeLessThanOrEqual(8000);
      expect(shotMs[1]).toBeGreaterThan(shotMs[0]);
      expect(holdMs).toBeGreaterThan(0);
      expect(holdMs).toBeLessThan(shotMs[0]);
      expect(pack.aesthetic.sound.targetLufs).toBeGreaterThanOrEqual(-20);
      expect(pack.aesthetic.sound.targetLufs).toBeLessThanOrEqual(-10);
      expect(pack.aesthetic.sound.duckingDb).toBeGreaterThanOrEqual(3);
      expect(pack.aesthetic.sound.duckingDb).toBeLessThanOrEqual(15);
      expect(["airy", "balanced", "dense"]).toContain(pack.aesthetic.composition.density);
    }
  });

  it("looks up one pack by theme and rejects unknown names", () => {
    expect(stylePackAesthetic("hand-note")).toBe(STYLE_PACKS.find((pack) => pack.name === "hand-note")!.aesthetic);
    expect(stylePackAesthetic("blueprint").typography.display).toBe("mono");
    expect(() => stylePackAesthetic("nope" as never)).toThrow(/Unknown style pack/);
  });
});
