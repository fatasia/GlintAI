// SPDX-License-Identifier: Apache-2.0
import { SceneEffect } from "./effects";

type LookPrimitive = Readonly<Pick<SceneEffect, "kind" | "value">>;

export interface LookPreset {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly colorDomain: "srgb-display-referred";
  readonly scope: "whole-frame-including-overlays";
  readonly fidelity: "inspired / approximate, not official simulation";
  readonly limitations: string;
  readonly provenance: {
    readonly author: "Glint contributors";
    readonly method: "independently-authored-primitive-recipe";
    readonly codeLicense: "Apache-2.0";
    readonly recipeLicense: "Apache-2.0";
    readonly externalLut: false;
    readonly sourcePhotographs: "none";
    readonly trademarkAssets: "none";
    readonly references: readonly string[];
  };
  /** Ordered operations, not camera settings and not a LUT. */
  readonly effects: readonly LookPrimitive[];
}

const provenance: LookPreset["provenance"] = Object.freeze({
  author: "Glint contributors",
  method: "independently-authored-primitive-recipe",
  codeLicense: "Apache-2.0",
  recipeLicense: "Apache-2.0",
  externalLut: false,
  sourcePhotographs: "none",
  trademarkAssets: "none",
  // Mathematical primitive semantics only; no third-party look values copied.
  references: Object.freeze([
    "https://www.w3.org/TR/filter-effects-1/#feComponentTransferElement",
    "https://www.w3.org/TR/filter-effects-1/#feColorMatrixElement",
  ]),
});

function preset(id: string, label: string, summary: string, effects: LookPrimitive[]): LookPreset {
  return Object.freeze({
    id, label, summary,
    colorDomain: "srgb-display-referred",
    scope: "whole-frame-including-overlays",
    fidelity: "inspired / approximate, not official simulation",
    limitations: "Global primitive approximation only: no camera profile, white balance, selective skin adjustment, film curve, grain or highlight recovery. Text and overlays are also affected.",
    provenance,
    effects: Object.freeze(effects.map(effect => Object.freeze(effect))),
  });
}

/** JSON-serializable local recipes. Brand simulations and proprietary LUT data are intentionally absent. */
export const LOOK_PRESETS: readonly LookPreset[] = Object.freeze([
  preset("restrained-print", "克制印色", "印刷感启发的近似：轻度降对比、降饱和与暖棕混合；不是胶片模拟。", [
    { kind: "contrast", value: 0.94 },
    { kind: "saturate", value: 0.86 },
    { kind: "sepia", value: 0.08 },
  ]),
  preset("soft-portrait", "柔和人像", "全局柔和近似：轻度降对比、降饱和并提亮；不识别人脸或修肤。", [
    { kind: "contrast", value: 0.94 },
    { kind: "saturate", value: 0.94 },
    { kind: "brightness", value: 1.025 },
  ]),
  preset("muted-color", "低彩纪实", "低彩审美启发的近似：降低全局饱和度、略增对比；没有选择性色彩。", [
    { kind: "saturate", value: 0.78 },
    { kind: "contrast", value: 1.06 },
  ]),
  preset("silver-mono", "简洁黑白", "黑白审美启发的近似：标准去色后略增对比；没有模拟银盐颗粒或相机滤镜。", [
    { kind: "grayscale", value: 1 },
    { kind: "contrast", value: 1.08 },
  ]),
]);

const identity = (kind: SceneEffect["kind"]): number =>
  kind === "brightness" || kind === "contrast" || kind === "saturate" ? 1 : 0;

/**
 * Parameter-space strength, NOT an output-pixel crossfade. 0 is an exact no-op;
 * 1 is the recipe. Callers must supply a distinct kebab-case prefix per inserted
 * instance when combining stacks; repeated identical arguments intentionally yield identical IDs.
 * Returns a new stack to replace effects, never silently appends to existing ones.
 */
export function makeLookPreset(id: string, strength = 1, prefix = `look-${id}`): SceneEffect[] {
  const look = LOOK_PRESETS.find(candidate => candidate.id === id);
  if (!look) throw new Error(`Unknown local look preset: ${id}`);
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error("Look strength must be a finite number between 0 and 1");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
    throw new Error("Look instance prefix must be nonempty kebab-case");
  }
  if (strength === 0) return [];
  return look.effects.map((effect, index) => SceneEffect.parse({
    id: `${prefix}-${index + 1}-${effect.kind}`,
    kind: effect.kind,
    value: identity(effect.kind) + (effect.value - identity(effect.kind)) * strength,
  }));
}
