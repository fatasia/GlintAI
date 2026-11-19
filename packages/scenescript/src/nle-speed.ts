export interface SpeedClip {
  durationMs: number;
  speed?: number;
  speedCurve?: "linear" | "in" | "out" | "bell";
  trimStartMs?: number;
  speedRamp?: { durationMs: number; offsetMs: number };
}

function shapeAt(curve: Exclude<SpeedClip["speedCurve"], undefined>, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (curve === "in") return 0.5 + x;
  if (curve === "out") return 1.5 - x;
  return 1 - 0.5 * Math.cos(2 * Math.PI * x);
}

/** Closed-form integral of shapeAt from 0 to t; defined for all real t. */
function shapeIntegral(curve: Exclude<SpeedClip["speedCurve"], undefined>, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  const body = curve === "in" ? (x + x * x) / 2 : curve === "out" ? 1.5 * x - x * x / 2
    : x - Math.sin(2 * Math.PI * x) / (4 * Math.PI);
  const clampLow = curve === "in" || curve === "bell" ? 0.5 : curve === "out" ? 1.5 : 1;
  const clampHigh = curve === "out" || curve === "bell" ? 0.5 : curve === "in" ? 1.5 : 1;
  return body + Math.min(0, t) * clampLow + Math.max(0, t - 1) * clampHigh;
}

export function nleSpeedAt(clip: SpeedClip, localMs: number): number {
  const base = clip.speed ?? 1, curve = clip.speedCurve;
  if (!curve || curve === "linear" || clip.durationMs <= 0) return base;
  const window = clip.speedRamp ?? { durationMs: clip.durationMs, offsetMs: 0 };
  return base * shapeAt(curve, (localMs + window.offsetMs) / window.durationMs);
}

/** Analytic integral of speed; random seek and sequential playback use the same source clock. */
export function nleSourceElapsedMs(clip: SpeedClip, localMs: number): number {
  const base = clip.speed ?? 1;
  if (!clip.speedCurve || clip.speedCurve === "linear") return localMs * base;
  const window = clip.speedRamp ?? { durationMs: clip.durationMs, offsetMs: 0 };
  return base * window.durationMs * (
    shapeIntegral(clip.speedCurve, (window.offsetMs + localMs) / window.durationMs)
    - shapeIntegral(clip.speedCurve, window.offsetMs / window.durationMs)
  );
}

export function nleSourceTimeMs(clip: SpeedClip, localMs: number): number {
  return (clip.trimStartMs ?? 0) + nleSourceElapsedMs(clip, localMs);
}

/**
 * Inverse of nleSourceTimeMs: the clip-local time that shows this source
 * timestamp. ASR reports source time for the whole file; captions must be
 * placed through this mapping so trims and curves do not shift them.
 */
export function nleLocalTimeAtSourceMs(clip: SpeedClip, sourceMs: number): number {
  const base = clip.trimStartMs ?? 0, speed = clip.speed ?? 1;
  if (!clip.speedCurve || clip.speedCurve === "linear") {
    return Math.min(clip.durationMs, Math.max(0, (sourceMs - base) / speed));
  }
  const end = nleSourceTimeMs(clip, clip.durationMs);
  if (sourceMs <= base) return 0;
  if (sourceMs >= end) return clip.durationMs;
  let low = 0, high = clip.durationMs;
  for (let step = 0; step < 40 && high - low > 1e-6; step++) {
    const middle = (low + high) / 2;
    if (nleSourceTimeMs(clip, middle) < sourceMs) low = middle;
    else high = middle;
  }
  return high;
}

/** Keep the original curve domain when cutting: each half must retain its old source samples. */
export function nleSpeedRampWindow(clip: SpeedClip, offsetMs = 0): SpeedClip["speedRamp"] {
  if (!clip.speedCurve || clip.speedCurve === "linear") return undefined;
  const window = clip.speedRamp ?? { durationMs: clip.durationMs, offsetMs: 0 };
  return { durationMs: window.durationMs, offsetMs: window.offsetMs + offsetMs };
}
