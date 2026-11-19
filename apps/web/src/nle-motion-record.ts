import type { NleClip, NleKeyframe } from "@glintai/scenescript";
import { clampMotion, motionFrameMs, NLE_MOTION_LIMIT } from "./nle-motion";

export interface MotionGesturePoint { elapsedMs: number; x: number; y: number }

function positionAt(points: readonly MotionGesturePoint[], elapsedMs: number): { x: number; y: number } {
  if (elapsedMs <= points[0]!.elapsedMs) return points[0]!;
  for (let index = 1; index < points.length; index++) {
    const to = points[index]!, from = points[index - 1]!;
    if (elapsedMs > to.elapsedMs) continue;
    const t = (elapsedMs - from.elapsedMs) / (to.elapsedMs - from.elapsedMs || 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  return points[points.length - 1]!;
}

/** Map one completed gesture across clip duration. Preserve existing times and all non-position data. */
export function sampleMotionGesture(clip: NleClip, input: readonly MotionGesturePoint[], fps: number): NleClip {
  if (!input.length) return clip;
  if (input.some(point => !Number.isFinite(point.elapsedMs) || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("录制含无效坐标，请重新录制。 ");
  const ordered = [...input].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const unique = new Map<number, MotionGesturePoint>();
  for (const point of ordered) unique.set(point.elapsedMs, { ...point, x: clampMotion(point.x, -1, 1), y: clampMotion(point.y, -1, 1) });
  const points = [...unique.values()], first = points[0]!.elapsedMs, span = points[points.length - 1]!.elapsedMs - first;
  if (points.length < 2 || span <= 0) throw new Error("请按住并拖动画布，再松开完成录制。 ");
  const lastMs = motionFrameMs(clip.durationMs, clip.durationMs, fps);
  const candidates = new Map<number, NleKeyframe>();
  for (const point of points) {
    const ms = motionFrameMs((point.elapsedMs - first) / span * lastMs, clip.durationMs, fps);
    candidates.set(ms, { ms, x: point.x, y: point.y, ease: "linear" });
  }
  candidates.set(0, { ms: 0, x: points[lastMs > 0 ? 0 : points.length - 1]!.x, y: points[lastMs > 0 ? 0 : points.length - 1]!.y, ease: "linear" });
  if (lastMs > 0) candidates.set(lastMs, { ms: lastMs, x: points[points.length - 1]!.x, y: points[points.length - 1]!.y, ease: "linear" });
  // Retain all existing properties, easing and keyframe timestamps, including off-grid imported ones.
  const selected = new Map<number, NleKeyframe>();
  for (const frame of clip.keyframes ?? []) {
    const xy = positionAt(points, first + (lastMs ? frame.ms / lastMs : 0) * span);
    selected.set(frame.ms, { ...frame, x: xy.x, y: xy.y });
  }
  for (const ms of [0, lastMs]) if (selected.size < NLE_MOTION_LIMIT && !selected.has(ms)) selected.set(ms, candidates.get(ms)!);
  // Greedy time-aware interpolation error, not every Nth event: corners survive the 32-point cap.
  while (selected.size < NLE_MOTION_LIMIT && selected.size < candidates.size + (clip.keyframes?.length ?? 0)) {
    const anchors = [...selected.values()].sort((a, b) => a.ms - b.ms);
    let best: NleKeyframe | undefined, error = -1;
    for (const point of candidates.values()) {
      if (selected.has(point.ms)) continue;
      const right = anchors.findIndex(anchor => anchor.ms >= point.ms);
      const from = anchors[Math.max(0, right - 1)] ?? point, to = anchors[right < 0 ? anchors.length - 1 : right] ?? point;
      const t = clampMotion((point.ms - from.ms) / (to.ms - from.ms || 1), 0, 1);
      const distance = Math.hypot(point.x! - (from.x! + (to.x! - from.x!) * t), point.y! - (from.y! + (to.y! - from.y!) * t));
      if (distance > error) { best = point; error = distance; }
    }
    if (!best || error < 0.002) break;
    selected.set(best.ms, best);
  }
  return { ...clip, keyframes: [...selected.values()].sort((a, b) => a.ms - b.ms) };
}
