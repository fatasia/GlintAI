import { Player } from "@remotion/player";
import { GlintVideo } from "@glintai/video";
import { buildTimeline, parseProject } from "@glintai/scenescript";
import { sizeByAspect } from "@glintai/video/size";
import { useMemo } from "react";

/** Loaded on intent, not during workbench startup. */
export default function ProjectPreview({ project }: { project: unknown }) {
  const parsed = useMemo(() => parseProject(project), [project]);
  const fps = parsed.fps ?? 30;
  const size = sizeByAspect[parsed.aspect];
  return <Player component={GlintVideo} inputProps={{ project: parsed }}
    durationInFrames={Math.max(1, Math.round(buildTimeline(parsed).totalMs * fps / 1000))}
    compositionWidth={size.width} compositionHeight={size.height} fps={fps}
    style={{ width: "100%", aspectRatio: `${size.width}/${size.height}` }} controls />;
}
