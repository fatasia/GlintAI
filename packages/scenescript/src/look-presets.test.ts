// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { effectFilterSvg, SceneEffect, wrapSvgEffects } from "./effects";
import { LOOK_PRESETS, makeLookPreset } from "./look-presets";

const identity = (kind: SceneEffect["kind"]) =>
  kind === "brightness" || kind === "contrast" || kind === "saturate" ? 1 : 0;

describe("independently authored local look registry", () => {
  it("is JSON-serializable and declares rights, input domain, approximation and scope per recipe", () => {
    expect(JSON.parse(JSON.stringify(LOOK_PRESETS))).toEqual(LOOK_PRESETS);
    expect(new Set(LOOK_PRESETS.map(look => look.id)).size).toBe(LOOK_PRESETS.length);
    expect(LOOK_PRESETS).toHaveLength(4);
    for (const look of LOOK_PRESETS) {
      expect(look.label.length).toBeGreaterThan(1);
      expect(look.summary).toContain("近似");
      expect(look.colorDomain).toBe("srgb-display-referred");
      expect(look.scope).toBe("whole-frame-including-overlays");
      expect(look.fidelity).toBe("inspired / approximate, not official simulation");
      expect(look.limitations).toContain("no camera profile");
      expect(look.provenance).toMatchObject({
        author: "Glint contributors", method: "independently-authored-primitive-recipe",
        codeLicense: "Apache-2.0", recipeLicense: "Apache-2.0",
        externalLut: false, sourcePhotographs: "none", trademarkAssets: "none",
      });
      expect(look.provenance.references.length).toBeGreaterThan(0);
      expect(look.provenance.references.every(url => url.startsWith("https://www.w3.org/"))).toBe(true);
      expect(look.effects.length).toBeLessThanOrEqual(16);
    }
  });

  it("freezes the registry, recipes, operations and provenance against accidental global edits", () => {
    expect(Object.isFrozen(LOOK_PRESETS)).toBe(true);
    for (const look of LOOK_PRESETS) {
      for (const value of [look, look.effects, ...look.effects, look.provenance, look.provenance.references]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
  });
});

describe("look preset instantiation", () => {
  it.each(LOOK_PRESETS.map(look => [look.id] as const))("validates every strength for %s against the existing schema", id => {
    for (let step = 0; step <= 100; step++) {
      const effects = makeLookPreset(id, step / 100, "scene-1-look-1");
      expect(effects.every(effect => SceneEffect.safeParse(effect).success)).toBe(true);
      expect(new Set(effects.map(effect => effect.id)).size).toBe(effects.length);
      if (step > 0) {
        expect(effectFilterSvg(effects, 0, "look-test").defs).toContain('color-interpolation-filters="sRGB"');
      }
    }
  });

  it("keeps strength 0 byte-identical through the real shared export helper", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Overlay</text></svg>';
    for (const look of LOOK_PRESETS) {
      const effects = makeLookPreset(look.id, 0);
      expect(effects).toEqual([]);
      expect(effectFilterSvg(effects, 0, "neutral").filter).toBe("none");
      expect(wrapSvgEffects(svg, effects, 0)).toBe(svg);
    }
  });

  it("interpolates each parameter from its correct identity and preserves operation order", () => {
    for (const look of LOOK_PRESETS) {
      const full = makeLookPreset(look.id);
      const half = makeLookPreset(look.id, 0.5);
      expect(full.map(({ kind, value }) => ({ kind, value }))).toEqual(look.effects);
      expect(half.map(effect => effect.kind)).toEqual(full.map(effect => effect.kind));
      half.forEach((effect, index) => {
        expect(effect.value).toBeCloseTo((identity(effect.kind) + full[index]!.value) / 2, 12);
      });
    }
  });

  it("creates deterministic, independent copies and caller-prefixed unique instances", () => {
    const first = makeLookPreset("restrained-print", 1, "scene-a-take-1");
    expect(makeLookPreset("restrained-print", 1, "scene-a-take-1")).toEqual(first);
    const second = makeLookPreset("restrained-print", 1, "scene-a-take-2");
    const combined = [...first, ...second];
    expect(new Set(combined.map(effect => effect.id)).size).toBe(combined.length);
    first[0]!.value = 0;
    expect(makeLookPreset("restrained-print", 1, "scene-a-take-1")[0]!.value).toBe(0.94);
    expect(LOOK_PRESETS[0]!.effects[0]!.value).toBe(0.94);
  });

  it.each([-0.01, 1.01, NaN, Infinity, -Infinity])("rejects invalid strength %s rather than silently clamping", strength => {
    expect(() => makeLookPreset("silver-mono", strength)).toThrow(/strength/);
  });

  it.each(["", "Upper", "two words", "a\"/><script>", "-leading", "a_b"])("rejects unsafe prefix %s even at zero strength", prefix => {
    expect(() => makeLookPreset("soft-portrait", 0, prefix)).toThrow(/prefix/);
  });

  it.each(["", "fuji-official", "__proto__", "constructor"])("rejects unknown look %s even at zero strength", id => {
    expect(() => makeLookPreset(id, 0)).toThrow(/Unknown/);
  });
});
