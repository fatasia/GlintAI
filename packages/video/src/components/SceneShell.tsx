import { AbsoluteFill, useVideoConfig } from "remotion";
import { FadeIn } from "./FadeIn";
import { FitContent } from "./FitContent";

const kickerChip: React.CSSProperties = {
  fontFamily: "var(--glint-font-mono)",
  fontSize: 23,
  letterSpacing: "0.18em",
  color: "var(--glint-color-text-muted)",
  background: "color-mix(in srgb, var(--glint-color-surface) 66%, transparent)",
  padding: "12px 26px",
  borderRadius: 999,
};

/**
 * Shared scene layout: content vertically centered (left- or center-aligned),
 * scene index chip top-left, brand mark top-right. Background colors
 * live on the composition root.
 */
export const SceneShell: React.FC<{
  children: React.ReactNode;
  align?: "start" | "center";
  kicker?: string;
  fit?: boolean;
}> = ({ children, align = "start", kicker, fit = true }) => {
  const centered = align === "center";
  const { width, height } = useVideoConfig();
  const narrow = width / height < 1.3;
  const side = narrow ? 76 : 170;
  return (
    <AbsoluteFill style={{ padding: `150px ${side}px 330px` }}>
      {kicker ? (
        <FadeIn style={{ position: "absolute", top: 72, left: side }}>
          <span style={kickerChip}>{kicker}</span>
        </FadeIn>
      ) : null}
      <div
        style={{
          position: "absolute",
          top: 72,
          right: side,
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontFamily: "var(--glint-font-display)",
          fontWeight: 700,
          fontSize: 26,
          color: "var(--glint-color-text-muted)",
        }}
      >
        Glint
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, var(--glint-color-accent), var(--glint-color-accent-2))",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: centered ? "center" : "flex-start",
          textAlign: centered ? "center" : "left",
          gap: 52,
          height: "100%",
          minWidth: 0,
        }}
      >
        {fit ? <FitContent centered={centered}>{children}</FitContent> : children}
      </div>
    </AbsoluteFill>
  );
};
