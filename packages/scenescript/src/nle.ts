import { z } from "zod";
import { LocalAssetPath } from "./assets";
import { SceneEffect } from "./effects";

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

const clipBase = {
  id,
  startMs: timeMs,
  durationMs,
  /** Source in-point before speed is applied. */
  trimStartMs: timeMs.optional(),
  speed: z.number().min(0.25).max(4).optional(),
  opacity: z.number().min(0).max(1).optional(),
  transform: NleTransform.optional(),
  transitionIn: NleTransition.optional(),
  transitionOut: NleTransition.optional(),
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
  }).strict(),
]);
export type NleClip = z.infer<typeof NleClip>;

export const NleTrack = z.object({
  id,
  kind: z.enum(["video", "overlay", "text", "audio"]),
  name: z.string().min(1).max(80),
  muted: z.boolean().optional(),
  locked: z.boolean().optional(),
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
    });
  });
});
export type NleProject = z.infer<typeof NleProject>;

export function parseNleProject(value: unknown): NleProject {
  return NleProject.parse(value);
}

export const DEFAULT_NLE_TRANSITION_MS = 500;

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

export function nleClipSourceEndMs(clip: Pick<NleClip, "trimStartMs" | "durationMs" | "speed">): number {
  return (clip.trimStartMs ?? 0) + clip.durationMs * (clip.speed ?? 1);
}

export function nleDurationMs(project: Pick<NleProject, "tracks">): number {
  let end = 0;
  for (const track of project.tracks) for (const clip of track.clips) end = Math.max(end, nleClipEndMs(clip));
  return end;
}

function mapClip(project: NleProject, trackId: string, clipId: string, update: (clip: NleClip) => NleClip | null): NleProject {
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
    if (edge === "end") return { ...clip, durationMs: Math.max(100, clip.durationMs + delta) } as NleClip;
    const nextStart = clip.startMs + delta;
    const nextDuration = clip.durationMs - delta;
    const nextTrim = (clip.trimStartMs ?? 0) + delta * (clip.speed ?? 1);
    if (nextStart < 0 || nextDuration < 100 || nextTrim < 0) return clip;
    return { ...clip, startMs: nextStart, durationMs: nextDuration, trimStartMs: nextTrim } as NleClip;
  });
}

/** Split at an absolute timeline position; the right half keeps the source offset. */
export function nleSplitClip(project: NleProject, trackId: string, clipId: string, atMs: number): NleProject {
  const track = project.tracks.find(item => item.id === trackId);
  const clip = track?.clips.find(item => item.id === clipId);
  if (!clip) return project;
  const at = Math.round(atMs), left = at - clip.startMs, right = clip.durationMs - left;
  if (left < 100 || right < 100) return project;
  const rightId = `${clip.id.slice(0, 55)}-b`;
  if (project.tracks.some(item => item.clips.some(candidate => candidate.id === rightId))) throw new Error("Split id already exists; rename the clip first");
  const first = { ...clip, durationMs: left } as NleClip;
  const second = { ...clip, id: rightId, startMs: at, durationMs: right, trimStartMs: (clip.trimStartMs ?? 0) + left * (clip.speed ?? 1) } as NleClip;
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
