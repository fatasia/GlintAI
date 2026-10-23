import { z } from "zod";
import { sampleTrack } from "./elements";

const RANGES = {
  brightness: [0, 3], contrast: [0, 3], saturate: [0, 3],
  grayscale: [0, 1], sepia: [0, 1], hue: [-180, 180], blur: [0, 30],
} as const;

// Kept independent of types.ts: that module imports SceneEffect at runtime.
const easing = z.union([
  z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  z.object({ bezier: z.tuple([
    z.number().finite().min(0).max(1), z.number().finite(),
    z.number().finite().min(0).max(1), z.number().finite(),
  ]) }).strict(),
]);

export const SceneEffect = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
  kind: z.enum(["brightness", "contrast", "saturate", "grayscale", "sepia", "hue", "blur"]),
  value: z.number().finite(),
  enabled: z.boolean().optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  keyframes: z.array(z.object({
    atMs: z.number().int().nonnegative(), value: z.number().finite(), easing: easing.optional(),
  }).strict()).min(1).max(64).optional(),
}).strict().superRefine((effect, context) => {
  const [min, max] = RANGES[effect.kind];
  const checkRange = (value: number, path: (string | number)[]) => {
    if (value < min || value > max) context.addIssue({
      code: z.ZodIssueCode.custom, path, message: `${effect.kind} must be between ${min} and ${max}`,
    });
  };
  checkRange(effect.value, ["value"]);
  const times = new Set<number>();
  effect.keyframes?.forEach((key, index) => {
    checkRange(key.value, ["keyframes", index, "value"]);
    if (times.has(key.atMs)) context.addIssue({
      code: z.ZodIssueCode.custom, path: ["keyframes", index, "atMs"], message: "duplicate keyframe time",
    });
    times.add(key.atMs);
  });
  if (effect.endMs !== undefined && effect.endMs <= (effect.startMs ?? 0)) context.addIssue({
    code: z.ZodIssueCode.custom, path: ["endMs"], message: "endMs must be greater than startMs",
  });
});
export type SceneEffect = z.infer<typeof SceneEffect>;
export type SampledEffect = Pick<SceneEffect, "id" | "kind" | "value">;

/** Scene-local times, active on [startMs, endMs); keyframes use that same clock. */
export function sampleEffects(effects: readonly SceneEffect[] | undefined, timeMs: number): SampledEffect[] {
  if (!Number.isFinite(timeMs)) throw new Error("Effect sample time must be finite");
  return (effects ?? []).filter(effect => effect.enabled !== false
    && timeMs >= (effect.startMs ?? 0) && (effect.endMs === undefined || timeMs < effect.endMs))
    .map(effect => {
      const value = effect.keyframes?.length ? sampleTrack({ keyframes: effect.keyframes }, timeMs) : effect.value;
      if (!Number.isFinite(value)) throw new Error(`Effect ${effect.id} produced a non-finite value`);
      const [min, max] = RANGES[effect.kind];
      // Custom bezier Y controls may overshoot: keep primitive parameters in the declared range.
      return { id: effect.id, kind: effect.kind, value: Math.min(max, Math.max(min, value)) };
    });
}

const number = (value: number) => String(Number(value.toFixed(9)));
const identityValue = (kind: SceneEffect["kind"]) =>
  kind === "brightness" || kind === "contrast" || kind === "saturate" ? 1 : 0;

function primitive(effect: SampledEffect, input: string, result: string): string {
  const attrs = `in="${input}" result="${result}"`;
  const value = number(effect.value);
  if (effect.kind === "brightness" || effect.kind === "contrast") {
    const intercept = effect.kind === "contrast" ? number((1 - effect.value) / 2) : "0";
    const channels = ["R", "G", "B"].map(channel =>
      `<feFunc${channel} type="linear" slope="${value}" intercept="${intercept}"/>`).join("");
    return `<feComponentTransfer ${attrs}>${channels}<feFuncA type="identity"/></feComponentTransfer>`;
  }
  if (effect.kind === "blur") return `<feGaussianBlur ${attrs} stdDeviation="${value}"/>`;
  if (effect.kind === "hue") return `<feColorMatrix ${attrs} type="hueRotate" values="${value}"/>`;
  if (effect.kind === "saturate" || effect.kind === "grayscale") {
    const saturation = effect.kind === "grayscale" ? number(1 - effect.value) : value;
    return `<feColorMatrix ${attrs} type="saturate" values="${saturation}"/>`;
  }
  // Sepia is an identity-to-sepia matrix blend; alpha is preserved, not tinted.
  const sepia = [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
  const matrix = sepia.map((target, index) => {
    const identity = index === 0 || index === 6 || index === 12 || index === 18 ? 1 : 0;
    return number(identity + (target - identity) * effect.value);
  }).join(" ");
  return `<feColorMatrix ${attrs} type="matrix" values="${matrix}"/>`;
}

/** Shared by browser and SVG export: never substitute CSS color functions. */
export function effectFilterSvg(
  effects: readonly SceneEffect[] | undefined, timeMs: number, filterId: string,
): { id: string; defs: string; filter: string } {
  // Reject rather than lossy-replace: two unsafe IDs must not alias the same filter.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(filterId)) throw new Error("Unsafe effect filter id");
  const id = `glint-fx-${filterId}`;
  const sampled = sampleEffects(effects, timeMs).filter(effect => effect.value !== identityValue(effect.kind));
  if (!sampled.length) return { id, defs: "", filter: "none" };
  const primitives = sampled.map((effect, index) => primitive(
    effect, index === 0 ? "SourceGraphic" : `${id}-step-${index - 1}`, `${id}-step-${index}`,
  )).join("");
  // Overscan includes blur tails at the supported 30px maximum on normal scene canvases.
  const defs = `<defs><filter id="${id}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${primitives}</filter></defs>`;
  return { id, defs, filter: `url(#${id})` };
}

/** Trusted renderer SVG only. Applies to the whole frame, including text/element overlays. */
export function wrapSvgEffects(svg: string, effects: readonly SceneEffect[] | undefined, timeMs: number): string {
  let filterId = "frame";
  let suffix = 0;
  while (new RegExp(`\\bid\\s*=\\s*["']glint-fx-${filterId}["']`).test(svg)) filterId = `frame-${++suffix}`;
  const output = effectFilterSvg(effects, timeMs, filterId);
  if (!output.defs) return svg;
  const root = /^(\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*>)([\s\S]*)(<\/svg>\s*)$/i.exec(svg);
  if (!root) throw new Error("Effects require a complete renderer SVG root");
  return `${root[1]}${output.defs}<g filter="${output.filter}">${root[2]}</g>${root[3]}`;
}
