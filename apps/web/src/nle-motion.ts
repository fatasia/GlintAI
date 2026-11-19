import { nleSampleMotion, type NleClip, type NleKeyframe, type NleMotion } from "@glintai/scenescript";

export const NLE_MOTION_LIMIT = 32;
export const MOTION_FIELDS = ["x", "y", "scale", "rotate", "opacity"] as const;
export type MotionField = typeof MOTION_FIELDS[number];
export const MOTION_LABELS: Record<MotionField, { label: string; min: number; max: number; step: number; unit: string }> = {
  x: { label: "水平位置", min: -1, max: 1, step: 0.01, unit: "画幅" },
  y: { label: "垂直位置", min: -1, max: 1, step: 0.01, unit: "画幅" },
  scale: { label: "缩放", min: 0.05, max: 8, step: 0.01, unit: "倍" },
  rotate: { label: "旋转", min: -180, max: 180, step: 1, unit: "度" },
  opacity: { label: "不透明度", min: 0, max: 1, step: 0.01, unit: "比例" },
};
export type MotionPatch = Partial<Omit<NleKeyframe, "ms">>;
export const clampMotion = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Match the engine's integer millisecond contract, not an accumulated rounded frame step. */
export function motionFrameMs(ms: number, durationMs: number, fps: number): number {
  if (!Number.isFinite(ms) || !Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error("时间须为有限数值，帧率须为 1–120。 ");
  const last = Math.floor(durationMs * fps / 1000 + 1e-8);
  return Math.round(clampMotion(Math.round(ms * fps / 1000), 0, last) * 1000 / fps);
}

export function stepMotionFrameMs(ms: number, direction: number, durationMs: number, fps: number): number {
  const frame = ms * fps / 1000;
  const next = direction > 0 ? Math.floor(frame + 0.06) + 1 : Math.ceil(frame - 0.06) - 1;
  return motionFrameMs(next * 1000 / fps, durationMs, fps);
}

function validatePatch(patch: MotionPatch): void {
  for (const field of MOTION_FIELDS) {
    const value = patch[field], bounds = MOTION_LABELS[field];
    if (value !== undefined && (!Number.isFinite(value) || value < bounds.min || value > bounds.max)) throw new Error(`${bounds.label}须在 ${bounds.min}–${bounds.max} 之间。`);
  }
  if (patch.ease !== undefined && !["linear", "in", "out"].includes(patch.ease)) throw new Error("仅支持线性、缓入和缓出。 ");
}

function withFrames(clip: NleClip, frames: NleKeyframe[]): NleClip {
  if (!frames.length) { const { keyframes: _removed, ...rest } = clip; return rest as NleClip; }
  return { ...clip, keyframes: frames.sort((a, b) => a.ms - b.ms) };
}

export function sampleMotion(clip: NleClip, localMs: number): NleMotion {
  return nleSampleMotion(clip, clampMotion(localMs, 0, clip.durationMs));
}

/** Existing fields at the same time are merged; no source/trim/static properties are rewritten. */
export function addMotionKeyframe(clip: NleClip, localMs: number, fps: number, patch?: MotionPatch): NleClip {
  const ms = motionFrameMs(localMs, clip.durationMs, fps);
  const existing = clip.keyframes?.find(frame => frame.ms === ms);
  if (!existing && (clip.keyframes?.length ?? 0) >= NLE_MOTION_LIMIT) throw new Error("已达 32 个关键帧上限，请先删除一个点。 ");
  const values = patch ?? sampleMotion(clip, ms);
  validatePatch(values);
  const next = { ...existing, ...values, ms };
  return withFrames(clip, [...(clip.keyframes ?? []).filter(frame => frame.ms !== ms), next]);
}

export function patchMotionKeyframe(clip: NleClip, ms: number, patch: MotionPatch): NleClip {
  validatePatch(patch);
  if (!clip.keyframes?.some(frame => frame.ms === ms)) throw new Error("关键帧已变化，请重新选择。 ");
  return withFrames(clip, clip.keyframes.map(frame => frame.ms === ms ? { ...frame, ...patch } : frame));
}

export function moveMotionKeyframe(clip: NleClip, fromMs: number, localMs: number, fps: number): NleClip {
  const ms = motionFrameMs(localMs, clip.durationMs, fps);
  if (!clip.keyframes?.some(frame => frame.ms === fromMs)) throw new Error("关键帧已变化，请重新选择。 ");
  if (ms === fromMs) return clip;
  if (clip.keyframes.some(frame => frame.ms === ms)) throw new Error("该帧已有关键帧，请移到空闲帧。 ");
  return withFrames(clip, clip.keyframes.map(frame => frame.ms === fromMs ? { ...frame, ms } : frame));
}

export function removeMotionKeyframe(clip: NleClip, ms: number): NleClip {
  if (!clip.keyframes?.some(frame => frame.ms === ms)) return clip;
  return withFrames(clip, clip.keyframes.filter(frame => frame.ms !== ms));
}

export function removeMotionField(clip: NleClip, ms: number, field: MotionField): NleClip {
  return withFrames(clip, (clip.keyframes ?? []).flatMap(frame => {
    if (frame.ms !== ms) return [frame];
    const next = { ...frame }; delete next[field];
    return MOTION_FIELDS.some(key => next[key] !== undefined) ? [next] : [];
  }));
}

/** Both SVGs are sampled by the same evaluator used by nle-dom; no second curve formula. */
export function motionPreviewSamples(clip: NleClip, count = 80): Array<NleMotion & { ms: number }> {
  const steps = clampMotion(Math.round(count), 2, 256);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ms = clip.durationMs * index / steps;
    return { ms, ...sampleMotion(clip, ms) };
  });
}

export function motionCurvePoints(clip: NleClip, field: MotionField): string {
  const samples = motionPreviewSamples(clip);
  const values = samples.map(sample => sample[field]);
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  return samples.map(sample => `${8 + sample.ms / clip.durationMs * 284},${max === min ? 60 : 112 - (sample[field] - min) / span * 104}`).join(" ");
}

export function motionPathPoints(clip: NleClip): string {
  return motionPreviewSamples(clip).map(sample => `${150 + sample.x * 130},${90 + sample.y * 70}`).join(" ");
}
