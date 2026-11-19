import { nleLocalTimeAtSourceMs, type NleClip } from "@glintai/scenescript";
import type { Transcript } from "@glintai/composer/asr";

export interface CaptionCue { id: string; text: string; startMs: number; durationMs: number }

const MIN_CAPTION_MS = 200;

/**
 * ASR timestamps refer to the whole source file. Map them through the clip's
 * source clock (trim, speed, curve) and drop anything outside the visible
 * range; captions are positioned on the timeline, never on the raw source.
 */
export function captionCuesForClip(transcript: Pick<Transcript, "segments">, clip: Pick<NleClip, "id" | "kind" | "startMs" | "durationMs" | "trimStartMs" | "speed" | "speedCurve" | "speedRamp">): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const [index, segment] of transcript.segments.entries()) {
    const text = segment.text.trim();
    if (!text || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs <= segment.startMs) continue;
    const localStart = nleLocalTimeAtSourceMs(clip, segment.startMs);
    const localEnd = nleLocalTimeAtSourceMs(clip, segment.endMs);
    if (localEnd <= 0 || localStart >= clip.durationMs) continue;
    const start = Math.max(0, localStart);
    const end = Math.min(clip.durationMs, Math.max(start, localEnd));
    const durationMs = Math.min(Math.max(MIN_CAPTION_MS, end - start), clip.durationMs - start);
    if (durationMs <= 0) continue;
    cues.push({
      id: `asr-${clip.id}-${index}-${Math.round(start)}`,
      text,
      startMs: clip.startMs + start,
      durationMs,
    });
  }
  return cues;
}
