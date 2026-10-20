import { useLayoutEffect } from "react";
import { Freeze, useCurrentFrame } from "remotion";
import { GlintVideo } from "@glintai/video";
export type SeekProps = { project: unknown; frameMap: number[] };
/** Verification-only harness: one document, frame-addressed component context, no reloads. */
export const SeekVerification: React.FC<SeekProps> = ({
  project,
  frameMap,
}) => {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    console.log(`[glint-seek-document] ${performance.timeOrigin}`);
  }, []);
  return (
    <Freeze frame={frameMap[frame] ?? 0}>
      <GlintVideo project={project} />
    </Freeze>
  );
};
