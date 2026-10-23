import { OffthreadVideo, useVideoConfig } from "remotion";
import { sceneDurationMs, videoSourceWindow, type VideoScene as VideoSceneModel } from "@glintai/scenescript";
import { Heading } from "../components/Heading";
import { useMediaAssetSrc } from "../components/MediaAssetContext";

/**
 * Plays a local video asset (media-gateway clip or user file) cover-fit for
 * the scene duration. Muted by design: narration owns the soundtrack; the
 * clip's own audio is dropped rather than ducked unpredictably.
 *
 * Trim and `speed` are resolved by the shared `videoSourceWindow`, so the
 * Remotion preview consumes the same source frames as the native renderer.
 */
export const VideoSceneView: React.FC<{ scene: VideoSceneModel }> = ({ scene }) => {
  const { width, height, fps } = useVideoConfig();
  const src = useMediaAssetSrc(scene.src);
  const durationFrames = Math.max(1, Math.round((sceneDurationMs(scene) / 1000) * fps));
  const source = videoSourceWindow(scene, fps, durationFrames);
  return <>
    {scene.caption && <Heading>{scene.caption}</Heading>}
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <OffthreadVideo
        src={src}
        muted
        startFrom={source.startFrom}
        endAt={source.endAt}
        playbackRate={source.playbackRate}
        style={{ width: "100%", height: "100%", objectFit: "cover", aspectRatio: `${width} / ${height}` }}
      />
    </div>
  </>;
};
