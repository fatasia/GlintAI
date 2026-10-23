import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { CameraMove, TransitionSpec } from "@glintai/scenescript";
import {
  cameraTransform,
  flashOverlayOpacity,
  transitionDurationFrames,
  transitionStyle,
} from "../motion";

/**
 * Whole-scene entrance transition. Applied to scene content only — captions
 * and narration stay outside so subtitles never animate or blur.
 */
export const TransitionIn: React.FC<{
  transition: TransitionSpec | undefined;
  children: React.ReactNode;
}> = ({ transition, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!transition) return <>{children}</>;
  const durationFrames = transitionDurationFrames(transition, fps);
  const p = durationFrames > 0 ? Math.min(1, frame / durationFrames) : 1;
  const style = transitionStyle(transition.in, p);
  const flash = flashOverlayOpacity(transition.in, p);
  return (
    <AbsoluteFill style={style}>
      {children}
      {flash > 0 ? (
        <AbsoluteFill style={{ background: "white", opacity: flash, pointerEvents: "none" }} />
      ) : null}
    </AbsoluteFill>
  );
};

/** Overflow-hidden wrapper applying the scene camera move over its duration. */
export const CameraFrame: React.FC<{
  camera: CameraMove | undefined;
  durationFrames: number;
  children: React.ReactNode;
}> = ({ camera, durationFrames, children }) => {
  const frame = useCurrentFrame();
  if (!camera || camera.type === "static" || durationFrames <= 1) return <>{children}</>;
  const { scale, translateX, translateY } = cameraTransform(camera, frame, durationFrames);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale.toFixed(4)}) translate(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px)`,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
