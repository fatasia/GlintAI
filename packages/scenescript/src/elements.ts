import type { AnimationTrack, Easing, Scene, SceneElement } from "./types";
import { interpolateMorphPath } from "./stroke-path";

/**
 * Object animation sampling shared by the SVG renderer and the Remotion overlay.
 * Both must produce the same value for the same millisecond; tests pin that.
 */

const EASING_PRESETS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  let u = clamp01(t);
  for (let i = 0; i < 8; i++) {
    const delta = sampleX(u) - t;
    if (Math.abs(delta) < 1e-6) return sampleY(u);
    const slope = slopeX(u);
    if (Math.abs(slope) < 1e-6) break;
    u = clamp01(u - delta / slope);
  }
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) {
    u = (low + high) / 2;
    if (sampleX(u) < t) low = u; else high = u;
  }
  return sampleY(u);
}

export function easeValue(t: number, easing?: Easing): number {
  const progress = Math.min(1, Math.max(0, t));
  if (!easing || easing === "linear") return progress;
  const points = typeof easing === "string" ? EASING_PRESETS[easing] ?? EASING_PRESETS.linear! : easing.bezier;
  return cubicBezier(points[0]!, points[1]!, points[2]!, points[3]!, progress);
}

/** Keyframes are sorted defensively; out-of-range times clamp to the ends. */
export function sampleTrack(track: Pick<AnimationTrack, "keyframes">, timeMs: number): number {
  const keys = [...track.keyframes].sort((a, b) => a.atMs - b.atMs);
  if (!keys.length) throw new Error("Animation track has no keyframes");
  if (timeMs <= keys[0]!.atMs) return keys[0]!.value;
  for (let index = 1; index < keys.length; index++) {
    const from = keys[index - 1]!, to = keys[index]!;
    if (timeMs <= to.atMs) {
      const span = to.atMs - from.atMs;
      if (span <= 0) return to.value;
      return from.value + (to.value - from.value) * easeValue((timeMs - from.atMs) / span, to.easing);
    }
  }
  return keys[keys.length - 1]!.value;
}

export interface ElementState {
  element: SceneElement;
  /** Normalized canvas coordinates (0..1) after animation. */
  x: number;
  y: number;
  opacity: number;
  scale: number;
  rotate: number;
}

export function evaluateElements(scene: Pick<Scene, "elements" | "tracks">, timeMs: number): ElementState[] {
  const states: ElementState[] = (scene.elements ?? []).map(element => ({
    element,
    x: element.x ?? 0.5,
    y: element.y ?? 0.5,
    opacity: 1,
    scale: 1,
    rotate: 0,
  }));
  const byId = new Map(states.map(state => [state.element.id, state]));
  for (const track of scene.tracks ?? []) {
    const state = byId.get(track.elementId);
    if (state) state[track.property] = sampleTrack(track, timeMs);
  }
  return states;
}

/** Rectangle morph is sampled from time alone, so seeking order cannot change it. */
export function evaluateMorphElements(scene: Scene, previous: Scene | undefined, timeMs: number): ElementState[] {
  const states = evaluateElements(scene, timeMs);
  if (scene.transition?.in !== "shape-morph") return states;
  if (!previous) throw new Error("shape-morph requires its previous scene");
  const sources = new Map((previous.elements ?? []).map(item => [item.id, item]));
  const t = Math.max(0, Math.min(1, timeMs / (scene.transition.durationMs ?? 800)));
  const progress = t * t * (3 - 2 * t);
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return states.map(state => {
    const target = state.element, source = sources.get(target.id);
    if (!source) return state;
    const color = (a: string, b: string) => `#${[1, 3, 5].map(i => Math.round(mix(parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16))).toString(16).padStart(2, "0")).join("")}`;
    if (target.kind === "path" && source.kind === "path") return {
      ...state, x: mix(source.x, target.x), y: mix(source.y, target.y),
      element: { ...target, w: mix(source.w, target.w), h: mix(source.h, target.h), d: interpolateMorphPath(source.d, target.d, progress), stroke: color(source.stroke, target.stroke), strokeWidth: mix(source.strokeWidth, target.strokeWidth) },
    };
    if (target.kind !== "rect" || source.kind !== "rect") return state;
    return { ...state, x: mix(source.x, target.x), y: mix(source.y, target.y), element: { ...target, w: mix(source.w, target.w), h: mix(source.h, target.h), radius: mix(source.radius ?? 0, target.radius ?? 0), fill: color(source.fill, target.fill) } };
  });
}

/** Fixed vector brush silhouette and dry-brush streaks, shared by all renderers. */
export const BRUSH_PATHS = [
  { d: "M5 39 L32 32 L20 29 L94 23 L75 19 L182 17 L171 13 L283 18 L353 12 L430 17 L526 14 L610 19 L708 14 L767 21 L835 18 L811 24 L931 26 L908 31 L987 35 L965 40 L998 44 L971 50 L989 55 L942 59 L966 63 L880 68 L897 72 L788 75 L805 78 L693 78 L627 84 L526 80 L447 85 L370 81 L286 86 L196 79 L117 80 L130 76 L47 72 L63 68 L13 63 L35 59 L2 54 L27 50 Z", opacity: 0.76 },
  { d: "M35 43 L254 33 L391 35 L547 29 L712 31 L928 37 L850 40 L679 39 L504 43 L308 41 L118 46 Z", opacity: 0.17 },
  { d: "M48 58 L195 55 L325 57 L479 51 L622 54 L821 48 L956 52 L894 57 L708 59 L565 57 L378 63 L201 61 Z", opacity: 0.13 },
] as const;
