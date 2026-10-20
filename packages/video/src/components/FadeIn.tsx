import { spring, useCurrentFrame, useVideoConfig } from "remotion";

/** Fade + rise entrance driven by Remotion springs (frame-based, deterministic). */
export const FadeIn: React.FC<{
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, distance = 30, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, mass: 0.6 },
  });
  return (
    <div
      style={{
        ...style,
        opacity: progress,
        // Pixel-aligned layers avoid cold-vs-cached iframe edge rasterization
        // differences caused by fractional parent transforms in Chromium.
        transform: `translateY(${Math.round((1 - progress) * distance)}px)`,
      }}
    >
      {children}
    </div>
  );
};
