import type { CameraMove, TransitionSpec } from "./types";

/**
 * Frame-derived motion math, split from the React components so the
 * transforms are unit-testable without a renderer. Everything here takes an
 * explicit frame/fps/duration — no clocks, no randomness (render
 * determinism red line).
 */

export const CAMERA_TYPES = ["static", "push", "pull", "pan-left", "pan-right", "drift"] as const;
export const TRANSITION_TYPES = [
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "wipe",
  "zoom-punch",
  "iris",
  "blur",
  "flip",
  "flash",
] as const;

export type CameraTransform = {
  scale: number;
  translateX: number;
  translateY: number;
  rotateX: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Ease-out cubic, the shared pacing for camera moves. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

/**
 * Camera transform at `frame` for a scene of `durationFrames`.
 * Travel is scaled by intensity (0..1, default 0.5); `drift` sways instead
 * of traveling so long scenes never slide off-frame.
 */
export function cameraTransform(
  camera: CameraMove | undefined,
  frame: number,
  durationFrames: number,
): CameraTransform {
  if (!camera || camera.type === "static" || durationFrames <= 1) {
    return { scale: 1, translateX: 0, translateY: 0, rotateX: 0 };
  }
  const intensity = camera.intensity ?? 0.5;
  const t = easeOutCubic(frame / (durationFrames - 1));
  // Pan travel is capped at ±72px @1080p so text never leaves the safe area;
  // push zoom tops out at +18% so oversized scenes don't crop captions.
  switch (camera.type) {
    case "push":
      return { scale: 1 + 0.18 * intensity * t, translateX: 0, translateY: 0, rotateX: 0 };
    case "pull":
      return { scale: 1 + 0.18 * intensity * (1 - t), translateX: 0, translateY: 0, rotateX: 0 };
    case "pan-left":
      return { scale: 1 + 0.06 * intensity, translateX: 36 * intensity * (1 - 2 * t), translateY: 0, rotateX: 0 };
    case "pan-right": {
      const mirror = cameraTransform({ type: "pan-left", intensity }, frame, durationFrames);
      return { ...mirror, translateX: -mirror.translateX };
    }
    case "drift": {
      // One gentle side-to-side pass; ends where it starts so the cut is clean.
      const sway = Math.sin(t * Math.PI) * 20 * intensity;
      return { scale: 1 + 0.04 * intensity, translateX: sway, translateY: 0, rotateX: 0 };
    }
    default:
      return { scale: 1, translateX: 0, translateY: 0, rotateX: 0 };
  }
}

export function beatPulseScale(pulse: { beatsMs: number[]; amount?: number; durationMs?: number } | undefined, timeMs: number): number {
  if (!pulse) return 1;
  const duration = pulse.durationMs ?? 280;
  let strength = 0;
  for (const beat of pulse.beatsMs) {
    const age = timeMs - beat;
    if (age >= 0 && age <= duration) strength = Math.max(strength, Math.sin(Math.PI * age / duration) * Math.exp(-2 * age / duration));
  }
  return 1 + (pulse.amount ?? 0.025) * strength;
}

export const DEFAULT_TRANSITION_MS = 800;

export function transitionDurationFrames(
  transition: TransitionSpec | undefined,
  fps: number,
): number {
  if (!transition) return 0;
  const ms = transition.durationMs ?? DEFAULT_TRANSITION_MS;
  return Math.max(2, Math.round((ms / 1000) * fps));
}

export type TransitionStyle = {
  opacity: number;
  transform: string;
  filter: string;
  clipPath: string;
};

const IDENTITY: TransitionStyle = {
  opacity: 1,
  transform: "none",
  filter: "none",
  clipPath: "none",
};

/**
 * Entrance style at progress p (0 = first frame, 1 = settled). Progress is
 * computed by the caller so the easing lives in one place.
 */
export function transitionStyle(type: TransitionSpec["in"], p: number): TransitionStyle {
  const t = clamp01(p);
  const eased = 1 - Math.pow(1 - t, 3);
  switch (type) {
    case "fade":
      return { ...IDENTITY, opacity: eased };
    case "slide-left":
      return { ...IDENTITY, opacity: eased, transform: `translateX(${Math.round((1 - eased) * 90)}px)` };
    case "slide-right":
      return { ...IDENTITY, opacity: eased, transform: `translateX(${Math.round((1 - eased) * -90)}px)` };
    case "slide-up":
      return { ...IDENTITY, opacity: eased, transform: `translateY(${Math.round((1 - eased) * 90)}px)` };
    case "wipe":
      return { ...IDENTITY, clipPath: `inset(0 ${(1 - eased) * 100}% 0 0)` };
    case "zoom-punch":
      return { ...IDENTITY, opacity: Math.min(1, eased * 1.6), transform: `scale(${1.22 - 0.22 * eased})` };
    case "iris":
      return { ...IDENTITY, clipPath: `circle(${(eased * 118).toFixed(2)}% at 50% 50%)` };
    case "blur":
      return { ...IDENTITY, opacity: eased, filter: `blur(${((1 - eased) * 14).toFixed(2)}px)` };
    case "flip":
      return {
        ...IDENTITY,
        opacity: Math.min(1, eased * 1.8),
        transform: `perspective(1400px) rotateX(${((1 - eased) * 62).toFixed(2)}deg)`,
      };
    case "flash": {
      // Content pops in fast; the flash afterglow is drawn by the wrapper in
      // the first 40% of the transition, so opacity here just snaps.
      return { ...IDENTITY, opacity: Math.min(1, t * 4), transform: `scale(${1.06 - 0.06 * Math.min(1, eased)})` };
    }
    default:
      return IDENTITY;
  }
}

/** Flash afterglow strength (0..1) drawn over the scene, first 40% only. */
export function flashOverlayOpacity(type: TransitionSpec["in"], p: number): number {
  if (type !== "flash") return 0;
  const t = clamp01(p / 0.4);
  return (1 - t) * 0.85;
}

/** Resolved one-shot SFX: absolute frame + static audio path. */
export interface PlacedSfx {
  sceneId: string;
  frame: number;
  effect: string;
  volume: number;
}

export interface SfxTimelineScene {
  id: string;
  narration: { segments?: { words?: { text: string; startMs: number }[] }[] };
  startFrame: number;
}

/**
 * Pins project-level SFX cues to absolute frames using narration word
 * timings. CJK narrations tokenize per character, so the cue is matched
 * against a sliding join of up to 4 consecutive tokens ("反转" matches
 * tokens 反|转). No match falls back to the scene start — a typo degrades
 * gracefully instead of silently dropping the effect.
 */
export function placeSfx(
  cues: { sceneId: string; word?: string; effect: string; gain?: number }[] | undefined,
  entries: SfxTimelineScene[],
  fps: number,
): PlacedSfx[] {
  const placed: PlacedSfx[] = [];
  for (const cue of cues ?? []) {
    const entry = entries.find((candidate) => candidate.id === cue.sceneId);
    if (!entry) continue;
    let offsetMs = 0;
    if (cue.word) {
      const words = entry.narration.segments?.flatMap((segment) => segment.words ?? []) ?? [];
      const needle = cue.word.toLowerCase();
      outer: for (let i = 0; i < words.length; i++) {
        let joined = "";
        for (let j = i; j < Math.min(words.length, i + 4); j++) {
          joined += words[j]!.text;
          if (joined.toLowerCase().startsWith(needle)) {
            offsetMs = words[i]!.startMs;
            break outer;
          }
          if (joined.length >= needle.length) break;
        }
      }
    }
    placed.push({
      sceneId: cue.sceneId,
      frame: entry.startFrame + Math.round((offsetMs / 1000) * fps),
      effect: cue.effect,
      volume: cue.gain ?? 0.5,
    });
  }
  return placed;
}
