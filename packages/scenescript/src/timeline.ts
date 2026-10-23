import type { Scene, SceneScriptProject } from "./types";
import { estimateNarrationDurationMs } from "./timing";
import { frameRateOf, framesForMs } from "./frame-rate";

export interface TimelineEntry {
  index: number;
  scene: Scene;
  startMs: number;
  durationMs: number;
}

export interface Timeline {
  entries: TimelineEntry[];
  totalMs: number;
}

/** Scene duration: explicit narration duration wins, otherwise estimate from text. */
export function sceneDurationMs(scene: Scene): number {
  const { narration } = scene;
  return (
    narration.durationMs ??
    estimateNarrationDurationMs(narration.text, {
      speakingRate: narration.speakingRate,
    })
  );
}

export function buildTimeline(project: SceneScriptProject): Timeline {
  const entries: TimelineEntry[] = [];
  let cursor = 0;
  project.scenes.forEach((scene, index) => {
    const durationMs = sceneDurationMs(scene);
    let startMs = cursor;
    if (index > 0) {
      // Cross-dissolve: this entrance overlaps the previous scene. The
      // overlap can never consume a whole neighbor — both stay drawable.
      const requested = scene.transition?.overlapMs ?? 0;
      const overlap = Math.max(0, Math.min(requested, durationMs - 200, entries[index - 1]!.durationMs - 200));
      startMs = cursor - overlap;
    }
    entries.push({ index, scene, startMs, durationMs });
    cursor = startMs + durationMs;
  });
  return { entries, totalMs: cursor };
}

export function msToFrames(ms: number, fps: number): number {
  return framesForMs(ms, frameRateOf(fps));
}

export interface FrameEntry {
  index: number;
  scene: Scene;
  from: number;
  duration: number;
}

/**
 * Converts the ms timeline to Remotion frames. Rounding is applied on
 * cumulative boundaries so per-scene rounding errors never accumulate.
 */
export function timelineToFrames(
  timeline: Timeline,
  fps: number,
): { entries: FrameEntry[]; durationInFrames: number } {
  const totalFrames = Math.max(1, msToFrames(timeline.totalMs, fps));
  const entries: FrameEntry[] = timeline.entries.map((entry, index) => {
    const from = msToFrames(entry.startMs, fps);
    const isLast = index === timeline.entries.length - 1;
    const rawTo = isLast
      ? totalFrames
      : msToFrames(entry.startMs + entry.durationMs, fps);
    return {
      index: entry.index,
      scene: entry.scene,
      from,
      duration: Math.max(1, rawTo - from),
    };
  });
  return { entries, durationInFrames: totalFrames };
}
