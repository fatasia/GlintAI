import { Player, type CallbackListener, type PlayerRef } from "@remotion/player";
import { GlintVideo } from "@glintai/video";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";
import { sizeByAspect } from "@glintai/video/size";
import { useEffect, useMemo, useRef } from "react";

export type ProjectPreviewProps = {
  project: unknown;
  selectedSceneId?: string;
  onSceneChange?(id: string): void;
  onFrameChange?(frame: number): void;
  initialFrame?: number;
};

const boundedFrame = (frame: number, duration: number) =>
  Math.max(0, Math.min(duration - 1, Number.isFinite(frame) ? Math.floor(frame) : 0));

/** Loaded on intent, not during workbench startup. */
export default function ProjectPreview({ project, selectedSceneId, onSceneChange, onFrameChange, initialFrame }: ProjectPreviewProps) {
  const parsed = useMemo(() => parseProject(project), [project]);
  const fps = parsed.fps ?? 30;
  const { entries, durationInFrames } = useMemo(() => timelineToFrames(buildTimeline(parsed), fps), [parsed, fps]);
  const size = sizeByAspect[parsed.aspect];
  const playerRef = useRef<PlayerRef>(null);
  // A restored playhead takes priority over the initial selection, but is never reapplied on edits.
  const startFrame = useRef(boundedFrame(initialFrame ?? entries.find(entry => entry.scene.id === selectedSceneId)?.from ?? 0, durationInFrames));
  const previousSelection = useRef(selectedSceneId);
  const reportedScene = useRef<string | undefined>(undefined);
  const playbackSelection = useRef<string | undefined>(undefined);
  const latest = useRef({ entries, selectedSceneId, onSceneChange, onFrameChange });
  latest.current = { entries, selectedSceneId, onSceneChange, onFrameChange };

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame: CallbackListener<"frameupdate"> = ({ detail: { frame } }) => {
      const current = latest.current;
      current.onFrameChange?.(frame);
      // Both neighbors are drawable during a dissolve; the last-started scene owns selection.
      let active;
      for (const entry of current.entries) {
        if (frame >= entry.from && frame < entry.from + entry.duration) active = entry;
      }
      if (active?.scene.id !== playbackSelection.current) playbackSelection.current = undefined;
      if (!active || active.scene.id === reportedScene.current) return;
      reportedScene.current = active.scene.id;
      if (active.scene.id !== current.selectedSceneId && current.onSceneChange) {
        playbackSelection.current = active.scene.id;
        current.onSceneChange(active.scene.id);
      }
    };
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, []);

  useEffect(() => {
    if (previousSelection.current === selectedSceneId) return;
    previousSelection.current = selectedSceneId;
    // The parent may echo playback selection back as a prop. Do not rewind that scene.
    const fromPlayback = playbackSelection.current === selectedSceneId;
    playbackSelection.current = undefined;
    if (fromPlayback) return;
    const entry = entries.find(item => item.scene.id === selectedSceneId);
    if (entry) playerRef.current?.seekTo(boundedFrame(entry.from, durationInFrames));
  }, [selectedSceneId, entries, durationInFrames]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const frame = player.getCurrentFrame();
    const clamped = boundedFrame(frame, durationInFrames);
    if (clamped !== frame) player.seekTo(clamped);
  }, [durationInFrames]);

  // Player validates initialFrame on every render, including after a duration shrink.
  return <Player ref={playerRef} component={GlintVideo} inputProps={{ project: parsed, mediaAssetBase: "/api/media/assets/" }}
    initialFrame={boundedFrame(startFrame.current, durationInFrames)} durationInFrames={durationInFrames}
    compositionWidth={size.width} compositionHeight={size.height} fps={fps}
    style={{ width: "100%", aspectRatio: `${size.width}/${size.height}` }} controls />;
}
