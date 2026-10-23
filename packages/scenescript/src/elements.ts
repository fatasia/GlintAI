import type { AnimationTrack, Easing, Scene, SceneElement } from "./types";

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
