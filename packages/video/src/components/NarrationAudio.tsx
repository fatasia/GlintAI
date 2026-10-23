import type { Scene } from "@glintai/scenescript";
import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";

export interface NarrationAudioProps {
  sceneStartFrame: number;
  compositionDurationFrames: number;
  scene: Scene;
}

/** Frame-quantized equivalent of native narrationAudioTimingMs. Invalid offsets mean zero. */
export function narrationAudioTimingFrames(
  sceneStartFrame: number,
  compositionDurationFrames: number,
  fps: number,
  audioOffsetMs = 0,
): { from: number; startFrom: number; durationInFrames: number } | null {
  if (!Number.isSafeInteger(sceneStartFrame) || !Number.isSafeInteger(compositionDurationFrames)
    || compositionDurationFrames <= 0 || !Number.isFinite(fps) || fps <= 0) return null;
  const offset = Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0;
  const start = sceneStartFrame + Math.round(offset / 1000 * fps);
  if (!Number.isSafeInteger(start)) return null;
  const from = Math.max(0, start);
  if (from >= compositionDurationFrames) return null;
  return { from, startFrom: Math.max(0, -start), durationInFrames: compositionDurationFrames - from };
}

/** Mount at composition level, not inside a scene Sequence: J cuts can precede the scene. */
export function NarrationAudio({ sceneStartFrame, compositionDurationFrames, scene }: NarrationAudioProps) {
  const { fps } = useVideoConfig();
  const timing = narrationAudioTimingFrames(sceneStartFrame, compositionDurationFrames, fps, scene.narration.audioOffsetMs);
  if (!scene.narration.audioRef || !timing) return null;
  // Like the original narration branch, plate mode does not silence narration.
  return (
    <Sequence from={timing.from} durationInFrames={timing.durationInFrames} layout="none" name={`Narration: ${scene.id}`}>
      <Audio src={staticFile(scene.narration.audioRef)} startFrom={timing.startFrom} />
    </Sequence>
  );
}
