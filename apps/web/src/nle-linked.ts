import { parseNleProject, type NleClip, type NleProject } from "@glintai/scenescript";

/**
 * Linked editing (联动): captions and overlays that sit mostly
 * inside a main-track clip follow its move/delete. Links are geometric — an
 * overlap of at least half the linked clip is a link — so there is no second
 * source of truth to keep in sync. Audio (music/voiceover) is deliberately not
 * linked: a bed that spans several shots must not be deleted with one shot.
 * The main track is the first non-locked video track.
 */
export function mainTrackOf(project: NleProject): NleProject["tracks"][number] | null {
  return project.tracks.find(track => track.kind === "video" && !track.locked) ?? null;
}

export interface LinkedEdit { project: NleProject; moved: number; removed: number }

interface Span { start: number; end: number }

function overlaps(clip: NleClip, span: Span): number {
  return Math.min(clip.startMs + clip.durationMs, span.end) - Math.max(clip.startMs, span.start);
}

/** A long music bed or a caption covering several shots is not owned by one shot. */
function linkedTo(clip: NleClip, span: Span): boolean {
  const cover = overlaps(clip, span);
  return cover > 0 && cover / clip.durationMs >= 0.5;
}

interface LinkedTarget { trackId: string; clip: NleClip }

function linkedTargets(project: NleProject, mainTrackId: string, spans: Span[], exclude: ReadonlySet<string>): LinkedTarget[] {
  const targets: LinkedTarget[] = [];
  for (const track of project.tracks) {
    if (track.id === mainTrackId || track.locked || track.kind === "audio") continue;
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue;
      if (spans.some(span => linkedTo(clip, span))) targets.push({ trackId: track.id, clip });
    }
  }
  return targets;
}

/**
 * Largest negative shift the linked group can take before a follower hits the
 * timeline origin. Callers fold this into the drag shift so the main clip and
 * its captions move by one identical amount.
 */
export function clampLinkedShift(project: NleProject, mainTrackId: string, mainClipIds: readonly string[], shiftMs: number, excludeClipIds: readonly string[] = []): number {
  if (shiftMs >= 0) return shiftMs;
  const mainTrack = project.tracks.find(track => track.id === mainTrackId);
  if (!mainTrack) return shiftMs;
  const ids = new Set(mainClipIds);
  const spans = mainTrack.clips.filter(clip => ids.has(clip.id)).map(clip => ({ start: clip.startMs, end: clip.startMs + clip.durationMs }));
  const targets = linkedTargets(project, mainTrackId, spans, new Set(excludeClipIds));
  return targets.length ? Math.max(shiftMs, -Math.min(...targets.map(target => target.clip.startMs))) : shiftMs;
}

/**
 * Move linked clips by the same shift as the primary edit. Pass every moving
 * main clip so a multi-selection carries the captions of all its shots; pass
 * `excludeClipIds` for clips the caller already moves itself (otherwise a
 * selected caption would be shifted twice).
 */
export function moveLinkedClips(
  project: NleProject,
  mainTrackId: string,
  mainClipId: string | readonly string[],
  shiftMs: number,
  options: { excludeClipIds?: readonly string[] } = {},
): LinkedEdit {
  const mainTrack = project.tracks.find(track => track.id === mainTrackId);
  const ids = new Set(typeof mainClipId === "string" ? [mainClipId] : mainClipId);
  if (!mainTrack || !ids.size || shiftMs === 0) return { project, moved: 0, removed: 0 };
  const excluded = new Set(options.excludeClipIds ?? []);
  const spans = mainTrack.clips
    .filter(clip => ids.has(clip.id))
    .map(clip => ({ start: clip.startMs - shiftMs, end: clip.startMs - shiftMs + clip.durationMs }));
  if (!spans.length) return { project, moved: 0, removed: 0 };
  const targets = linkedTargets(project, mainTrackId, spans, excluded);
  if (!targets.length) return { project, moved: 0, removed: 0 };
  // One shift for every linked clip: clamping each independently would shear
  // their relative alignment against the main clip.
  const applied = Math.max(shiftMs, -Math.min(...targets.map(target => target.clip.startMs)));
  const moving = new Set(targets.map(target => target.clip.id));
  const next = parseNleProject({
    ...project,
    tracks: project.tracks.map(track => track.id === mainTrackId ? track : {
      ...track,
      clips: track.clips.map(clip => moving.has(clip.id) ? { ...clip, startMs: clip.startMs + applied } : clip),
    }),
  });
  return { project: next, moved: targets.length, removed: 0 };
}

/** Delete linked clips whose majority sits inside the removed spans. */
export function removeLinkedClips(project: NleProject, mainTrackId: string, removedSpans: Span[]): LinkedEdit {
  if (!removedSpans.length) return { project, moved: 0, removed: 0 };
  let removed = 0;
  const next = parseNleProject({
    ...project,
    tracks: project.tracks.map(track => {
      if (track.id === mainTrackId || track.locked || track.kind === "audio") return track;
      return {
        ...track,
        clips: track.clips.filter(clip => {
          const hit = removedSpans.some(span => linkedTo(clip, span));
          if (hit) removed += 1;
          return !hit;
        }),
      };
    }),
  });
  return { project: next, moved: 0, removed };
}

/** Whole-clip delete on the main track: the span comes from the clip itself. */
export function removeMainWithLinked(project: NleProject, mainTrackId: string, mainClipId: string): LinkedEdit {
  const mainTrack = project.tracks.find(track => track.id === mainTrackId);
  const mainClip = mainTrack?.clips.find(clip => clip.id === mainClipId);
  if (!mainTrack || !mainClip) return { project, moved: 0, removed: 0 };
  const span = { start: mainClip.startMs, end: mainClip.startMs + mainClip.durationMs };
  const withoutMain = parseNleProject({ ...project, tracks: project.tracks.map(track => track.id !== mainTrackId ? track : { ...track, clips: track.clips.filter(clip => clip.id !== mainClipId) }) });
  return removeLinkedClips(withoutMain, mainTrackId, [span]);
}
