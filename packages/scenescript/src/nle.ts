import { z } from "zod";
import { LocalAssetPath } from "./assets";
import { SceneEffect } from "./effects";
import { nleLocalTimeAtSourceMs, nleSourceTimeMs, nleSpeedRampWindow } from "./nle-speed";
export { nleLocalTimeAtSourceMs, nleSpeedAt, nleSourceElapsedMs, nleSourceTimeMs } from "./nle-speed";

/**
 * A desktop multi-track timeline, separate from SceneScript.
 *
 * SceneScript describes an authored film (scenes, narration, theme); this
 * describes an edit (tracks, clips, trims). Keeping them apart means the NLE
 * can cut generated footage, camera files and music without rewriting the
 * scene contract or breaking existing projects.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "ids are lowercase kebab-case");
const timeMs = z.number().int().nonnegative().max(6 * 60 * 60 * 1000);
const durationMs = z.number().int().min(100).max(6 * 60 * 60 * 1000);

export const NleTransform = z.object({
  x: z.number().min(-1).max(1).optional(),
  y: z.number().min(-1).max(1).optional(),
  scale: z.number().min(0.05).max(8).optional(),
  rotate: z.number().min(-180).max(180).optional(),
}).strict();
export type NleTransform = z.infer<typeof NleTransform>;

/** An edge transition rendered inside the clip's own duration (no overlap needed). */
export const NleTransition = z.object({
  type: z.enum(["fade", "slide", "zoom", "wipe"]),
  durationMs: z.number().int().min(100).max(5000).optional(),
}).strict();
export type NleTransition = z.infer<typeof NleTransition>;

/** Clip-local animated property sample; absent fields are not keyframed. */
export const NleKeyframe = z.object({
  /** Clip-local time in ms; keyframes must be strictly ascending. */
  ms: timeMs,
  x: z.number().min(-1).max(1).optional(),
  y: z.number().min(-1).max(1).optional(),
  scale: z.number().min(0.05).max(8).optional(),
  rotate: z.number().min(-180).max(180).optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** Easing used on the segment leaving this keyframe. */
  ease: z.enum(["linear", "in", "out"]).optional(),
}).strict();
export type NleKeyframe = z.infer<typeof NleKeyframe>;

/** Compositing mode of a visual clip against what is below it. */
export const NleBlend = z.enum(["normal", "screen", "multiply", "overlay", "darken", "lighten", "soft-light"]);
export type NleBlend = z.infer<typeof NleBlend>;

/** Geometric alpha mask in clip space; feather is a share of the shorter side. */
export const NleMask = z.object({
  shape: z.enum(["circle", "rect"]),
  /** Rect only: inset from each edge as a share of that dimension. */
  inset: z.number().min(0).max(0.45).optional(),
  /** Edge softness, 0..0.5 of the shorter side. */
  feather: z.number().min(0).max(0.5).optional(),
  invert: z.boolean().optional(),
}).strict();
export type NleMask = z.infer<typeof NleMask>;

const clipBase = {
  id,
  startMs: timeMs,
  durationMs,
  /** Source time retains fractional milliseconds after a nonlinear cut. */
  trimStartMs: z.number().finite().nonnegative().max(6 * 60 * 60 * 1000).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  /** Speed ramp over clip time: linear (constant speed), in (slow→fast), out (fast→slow), bell (slow-fast-slow). */
  speedCurve: z.enum(["linear", "in", "out", "bell"]).optional(),
  /** Original curve domain retained across split/trim; offsets may extend past either end. */
  speedRamp: z.object({ durationMs, offsetMs: z.number().finite().min(-6 * 60 * 60 * 1000).max(6 * 60 * 60 * 1000) }).strict().optional(),
  opacity: z.number().min(0).max(1).optional(),
  transform: NleTransform.optional(),
  transitionIn: NleTransition.optional(),
  transitionOut: NleTransition.optional(),
  /** 1..32 ascending clip-local keyframes; animated fields override the static ones. A single keyframe pins the property from that time on. */
  keyframes: z.array(NleKeyframe).min(1).max(32).optional(),
  blend: NleBlend.optional(),
  mask: NleMask.optional(),
  effects: z.array(SceneEffect).max(8).optional(),
};

export const NleClip = z.discriminatedUnion("kind", [
  z.object({ ...clipBase, kind: z.literal("video"), src: LocalAssetPath, volume: z.number().min(0).max(1).optional() }).strict(),
  z.object({ ...clipBase, kind: z.literal("image"), src: LocalAssetPath }).strict(),
  z.object({ ...clipBase, kind: z.literal("audio"), src: LocalAssetPath, volume: z.number().min(0).max(1).optional() }).strict(),
  z.object({
    ...clipBase,
    kind: z.literal("text"),
    text: z.string().min(1).max(500),
    fontSize: z.number().min(12).max(240).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    weight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    /** AUDIO-05/07 karaoke captions: chars light up by character-ratio progress
     * across the clip (declared approximation, not acoustic word timing). */
    karaoke: z.boolean().optional(),
  }).strict(),
]);
export type NleClip = z.infer<typeof NleClip>;

export const NleTrack = z.object({
  id,
  kind: z.enum(["video", "overlay", "text", "audio"]),
  name: z.string().min(1).max(80),
  muted: z.boolean().optional(),
  locked: z.boolean().optional(),
  /** Audition isolation: when any track carries solo, every non-solo track is silent. */
  solo: z.boolean().optional(),
  clips: z.array(NleClip).max(200),
}).strict();
export type NleTrack = z.infer<typeof NleTrack>;

const VISUAL: Record<NleTrack["kind"], NleClip["kind"][]> = {
  video: ["video", "image"],
  overlay: ["video", "image", "text"],
  text: ["text"],
  audio: ["audio"],
};

export const NleProject = z.object({
  schemaVersion: z.literal(1),
  id,
  title: z.string().min(1).max(200),
  fps: z.number().min(1).max(120),
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(4320),
  background: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  tracks: z.array(NleTrack).max(8),
}).strict().superRefine((project, ctx) => {
  const trackIds = new Set<string>(), clipIds = new Set<string>();
  project.tracks.forEach((track, trackIndex) => {
    if (trackIds.has(track.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "id"], message: `duplicate track id "${track.id}"` });
    trackIds.add(track.id);
    track.clips.forEach((clip, clipIndex) => {
      if (clipIds.has(clip.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips", clipIndex, "id"], message: `duplicate clip id "${clip.id}"` });
      clipIds.add(clip.id);
      if (!VISUAL[track.kind].includes(clip.kind)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips", clipIndex, "kind"], message: `${clip.kind} clip is not allowed on a ${track.kind} track` });
      clip.keyframes?.forEach((frame, frameIndex) => {
        if (frameIndex > 0 && frame.ms <= clip.keyframes![frameIndex - 1]!.ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips", clipIndex, "keyframes", frameIndex, "ms"], message: "keyframes must be strictly ascending" });
      });
    });
  });
});
export type NleProject = z.infer<typeof NleProject>;

/** Alpha export only supports text overlays: image/video pixels may be opaque. */
export function nleAlphaIssues(project: NleProject): Array<{ trackId: string; clipId: string; reason: string }> {
  return project.tracks.flatMap(track => track.clips.flatMap(clip =>
    clip.kind === "image" || clip.kind === "video"
      ? [{ trackId: track.id, clipId: clip.id, reason: `${clip.kind} 画面不支持透明导出；请移除该片段。` }]
      : []));
}

export function parseNleProject(value: unknown): NleProject {
  return NleProject.parse(value);
}

export const DEFAULT_NLE_TRANSITION_MS = 500;

const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const EASINGS: Record<NonNullable<NleKeyframe["ease"]>, (t: number) => number> = { linear: t => t, in: easeInQuad, out: easeOutCubic };

export interface NleMotion { x: number; y: number; scale: number; rotate: number; opacity: number }

/**
 * Motion sample at a clip-local time. Without keyframes this is the static
 * transform; a single keyframe pins each animated field to its value (from
 * that time on, stepping outside the first/last sample); with two or more,
 * each animated field is interpolated independently between its own
 * surrounding keyframes, while fields never keyframed keep their static value.
 */
export function nleSampleMotion(clip: Pick<NleClip, "transform" | "opacity" | "keyframes">, localMs: number): NleMotion {
  const base: NleMotion = { x: clip.transform?.x ?? 0, y: clip.transform?.y ?? 0, scale: clip.transform?.scale ?? 1, rotate: clip.transform?.rotate ?? 0, opacity: clip.opacity ?? 1 };
  const keyframes = clip.keyframes;
  if (!keyframes?.length) return base;
  const sample = (field: "x" | "y" | "scale" | "rotate" | "opacity"): number => {
    const frames = keyframes.filter(frame => frame[field] !== undefined) as Array<NleKeyframe & { [K in typeof field]: number }>;
    if (!frames.length) return base[field];
    if (localMs <= frames[0]!.ms) return frames[0]![field];
    if (localMs >= frames[frames.length - 1]!.ms) return frames[frames.length - 1]![field];
    for (let index = 1; index < frames.length; index++) {
      if (localMs > frames[index]!.ms) continue;
      const from = frames[index - 1]!, to = frames[index]!;
      const span = to.ms - from.ms;
      const progress = span <= 0 ? 1 : EASINGS[from.ease ?? "linear"]((localMs - from.ms) / span);
      return from[field] + (to[field] - from[field]) * progress;
    }
    return frames[frames.length - 1]![field];
  };
  return { x: sample("x"), y: sample("y"), scale: sample("scale"), rotate: sample("rotate"), opacity: sample("opacity") };
}

/** Progress 0..1 of the incoming/outgoing transition at a clip-local time; null without one. */
export function nleTransitionProgress(clip: Pick<NleClip, "durationMs" | "transitionIn" | "transitionOut">, localMs: number, edge: "in" | "out"): number | null {
  const transition = edge === "in" ? clip.transitionIn : clip.transitionOut;
  if (!transition) return null;
  const duration = Math.min(transition.durationMs ?? DEFAULT_NLE_TRANSITION_MS, clip.durationMs);
  if (duration <= 0) return null;
  const elapsed = edge === "in" ? localMs : clip.durationMs - localMs;
  return Math.min(1, Math.max(0, elapsed / duration));
}

/** Edges other clips and the playhead can snap to, in timeline milliseconds. */
export function nleSnapPoints(project: Pick<NleProject, "tracks">, options: { playheadMs?: number; excludeClipIds?: readonly string[] } = {}): number[] {
  const excluded = new Set(options.excludeClipIds ?? []), points = new Set<number>([0]);
  if (options.playheadMs !== undefined) points.add(Math.round(options.playheadMs));
  for (const track of project.tracks) for (const clip of track.clips) {
    if (excluded.has(clip.id)) continue;
    points.add(clip.startMs);
    points.add(clip.startMs + clip.durationMs);
  }
  return [...points].sort((a, b) => a - b);
}

/** Nearest snap point within thresholdMs, or null. */
export function nleSnap(valueMs: number, points: readonly number[], thresholdMs: number): number | null {
  let best: number | null = null, distance = thresholdMs;
  for (const point of points) {
    const delta = Math.abs(point - valueMs);
    if (delta <= distance) { distance = delta; best = point; }
  }
  return best;
}

export function nleClipEndMs(clip: Pick<NleClip, "startMs" | "durationMs">): number {
  return clip.startMs + clip.durationMs;
}

export function nleClipSourceEndMs(clip: Pick<NleClip, "trimStartMs" | "durationMs" | "speed" | "speedCurve" | "speedRamp">): number {
  return nleSourceTimeMs(clip, clip.durationMs);
}

export function nleDurationMs(project: Pick<NleProject, "tracks">): number {
  let end = 0;
  for (const track of project.tracks) for (const clip of track.clips) end = Math.max(end, nleClipEndMs(clip));
  return end;
}

function mapClip(project: NleProject, trackId: string, clipId: string, update: (clip: NleClip) => NleClip | null): NleProject {
  if (project.tracks.find(track => track.id === trackId)?.locked) return project;
  return parseNleProject({
    ...project,
    tracks: project.tracks.map(track => track.id !== trackId ? track : {
      ...track,
      clips: track.clips.flatMap(clip => {
        if (clip.id !== clipId) return [clip];
        const next = update(clip);
        return next ? [next] : [];
      }),
    }),
  });
}

export function nleMoveClip(project: NleProject, trackId: string, clipId: string, startMs: number): NleProject {
  return mapClip(project, trackId, clipId, clip => ({ ...clip, startMs: Math.max(0, Math.round(startMs)) } as NleClip));
}

/** Trim the left or right edge by deltaMs; source in-point follows a left trim. */
export function nleTrimClip(project: NleProject, trackId: string, clipId: string, edge: "start" | "end", deltaMs: number): NleProject {
  return mapClip(project, trackId, clipId, clip => {
    const delta = Math.round(deltaMs);
    if (edge === "end") return { ...clip, durationMs: Math.max(100, clip.durationMs + delta), speedRamp: nleSpeedRampWindow(clip) } as NleClip;
    const nextStart = clip.startMs + delta;
    const nextDuration = clip.durationMs - delta;
    const nextTrim = nleSourceTimeMs(clip, delta);
    if (nextStart < 0 || nextDuration < 100 || nextTrim < 0) return clip;
    return { ...clip, startMs: nextStart, durationMs: nextDuration, trimStartMs: nextTrim, speedRamp: nleSpeedRampWindow(clip, delta) } as NleClip;
  });
}

/**
 * Roll edit: move the shared boundary between a clip and its adjacent right
 * neighbour (same track, right.startMs === left end). The left clip's length
 * changes by delta while the right clip keeps the timeline seam sealed and its
 * source in-point follows, so total track length is unchanged. Clamps so both
 * sides stay >= 100ms; without an adjacent neighbour or a non-zero delta the
 * project is returned unchanged.
 */
export function nleRollEdit(project: NleProject, trackId: string, clipId: string, deltaMs: number): NleProject {
  const track = project.tracks.find(item => item.id === trackId);
  const left = track?.clips.find(item => item.id === clipId);
  if (!track || track.locked || !left) return project;
  const boundary = left.startMs + left.durationMs;
  const right = track.clips.find(item => item.startMs === boundary && item.id !== clipId);
  if (!right) return project;
  // Source time is monotone even outside a ramp; binary search retains the last valid millisecond.
  let lower = -(left.durationMs - 100);
  if (nleSourceTimeMs(right, lower) < 0) {
    let high = 0;
    while (high - lower > 1) {
      const middle = Math.floor((lower + high) / 2);
      if (nleSourceTimeMs(right, middle) < 0) lower = middle;
      else high = middle;
    }
    lower = high;
  }
  const upper = right.durationMs - 100;
  const clamped = Math.max(lower, Math.min(upper, Math.round(deltaMs)));
  if (clamped === 0 || (deltaMs > 0 && clamped < 0) || (deltaMs < 0 && clamped > 0)) return project;
  return parseNleProject({ ...project, tracks: project.tracks.map(item => item.id !== trackId ? item : {
    ...item,
    clips: item.clips.map(clip => {
      if (clip.id === left.id) return { ...clip, durationMs: clip.durationMs + clamped, speedRamp: nleSpeedRampWindow(clip) } as NleClip;
      if (clip.id === right.id) return { ...clip, startMs: clip.startMs + clamped, durationMs: clip.durationMs - clamped, trimStartMs: nleSourceTimeMs(clip, clamped), speedRamp: nleSpeedRampWindow(clip, clamped) } as NleClip;
      return clip;
    }),
  }) });
}

/** Split at an absolute timeline position; the right half keeps the source offset. */
export function nleSplitClip(project: NleProject, trackId: string, clipId: string, atMs: number): NleProject {
  const track = project.tracks.find(item => item.id === trackId);
  const clip = track?.clips.find(item => item.id === clipId);
  if (!clip || track?.locked) return project;
  const at = Math.round(atMs), left = at - clip.startMs, right = clip.durationMs - left;
  if (left < 100 || right < 100) return project;
  const rightId = `${clip.id.slice(0, 55)}-b`;
  if (project.tracks.some(item => item.clips.some(candidate => candidate.id === rightId))) throw new Error("Split id already exists; rename the clip first");
  const first = { ...clip, durationMs: left, speedRamp: nleSpeedRampWindow(clip) } as NleClip;
  const second = { ...clip, id: rightId, startMs: at, durationMs: right, trimStartMs: nleSourceTimeMs(clip, left), speedRamp: nleSpeedRampWindow(clip, left) } as NleClip;
  return parseNleProject({ ...project, tracks: project.tracks.map(item => item.id !== trackId ? item : { ...item, clips: item.clips.flatMap(candidate => candidate.id === clipId ? [first, second] : [candidate]) }) });
}

export function nleRemoveClip(project: NleProject, trackId: string, clipId: string): NleProject {
  return mapClip(project, trackId, clipId, () => null);
}

/** Append an empty track of the given kind; ids are generated (v1/t1/a1 style). */
export function nleAddTrack(project: NleProject, kind: NleTrack["kind"], name?: string): NleProject {
  const prefixes: Record<NleTrack["kind"], string> = { video: "v", overlay: "v", text: "t", audio: "a" };
  const used = new Set(project.tracks.map(track => track.id));
  let id = "";
  for (let index = 1; ; index++) {
    const candidate = `${prefixes[kind]}${index}`;
    if (!used.has(candidate)) { id = candidate; break; }
  }
  return parseNleProject({
    ...project,
    tracks: [...project.tracks, { id, kind, name: name ?? id.toUpperCase(), clips: [] }],
  });
}

/** Delete a whole track including its clips; undo in the caller's hands. */
export function nleRemoveTrack(project: NleProject, trackId: string): NleProject {
  if (!project.tracks.some(track => track.id === trackId)) return project;
  return parseNleProject({ ...project, tracks: project.tracks.filter(track => track.id !== trackId) });
}

/**
 * Magnetic main track: close every gap on the track by laying its clips out
 * head-to-tail starting at the earliest clip's original start. Order comes from
 * the current start times, so a moved clip changes sequence before the join.
 */
export function nleMagnetizeTrack(project: NleProject, trackId: string): NleProject {
  const track = project.tracks.find(item => item.id === trackId);
  if (!track || track.clips.length < 2) return project;
  const ordered = [...track.clips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  const base = ordered[0]!.startMs;
  let cursor = base;
  const clips = ordered.map(clip => {
    const next = { ...clip, startMs: cursor };
    cursor += clip.durationMs;
    return next as NleClip;
  });
  const before = new Map(track.clips.map(clip => [clip.id, clip.startMs]));
  if (clips.every(clip => before.get(clip.id) === clip.startMs)) return project;
  return parseNleProject({ ...project, tracks: project.tracks.map(item => item.id !== trackId ? item : { ...item, clips }) });
}
