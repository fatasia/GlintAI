import type { ComparisonScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";
import { Heading } from "../components/Heading";
import { useVideoConfig } from "remotion";

interface Side {
  label: string;
  points: string[];
  accentVar: string;
}

const cardStyle = (accentVar: string): React.CSSProperties => ({
  flex: 1,
  minWidth: 0,
  background: `linear-gradient(180deg, color-mix(in srgb, ${accentVar} 7%, var(--glint-color-surface)), var(--glint-color-surface))`,
  border: "var(--glint-line-hairline)",
  borderRadius: "var(--glint-radius)",
  boxShadow: "var(--glint-shadow-card), var(--glint-shadow-inner-highlight)",
  padding: "52px 60px",
  display: "flex",
  flexDirection: "column",
  gap: 30,
});

export const ComparisonSceneView: React.FC<{ scene: ComparisonScene }> = ({
  scene,
}) => {
  const { width, height } = useVideoConfig();
  const narrow = width / height < 1.3;
  const sides: Side[] = [
    { ...scene.left, accentVar: "var(--glint-color-accent)" },
    { ...scene.right, accentVar: "var(--glint-color-accent-2)" },
  ];
  return (
    <>
      {scene.heading ? (
        <FadeIn>
          <Heading>{scene.heading}</Heading>
        </FadeIn>
      ) : null}
      <div
        style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: narrow ? 36 : 76, width: "100%", position: "relative" }}
      >
        {sides.map((side, sideIndex) => (
          <FadeIn
            key={`${sideIndex}-${side.label}`}
            delay={8 + sideIndex * 8}
            style={{ flex: 1, minWidth: 0 }}
          >
            <div
              style={{
                ...cardStyle(side.accentVar),
                borderTop: `8px solid ${side.accentVar}`,
              }}
            >
              <span
                style={{
                  fontSize: "var(--glint-font-size-h2)",
                  fontWeight: 700,
                  fontFamily: "var(--glint-font-display)",
                  color: side.accentVar,
                }}
              >
                {side.label}
              </span>
              {side.points.map((point) => (
                <span
                  key={point}
                  style={{
                    fontSize: "var(--glint-font-size-body)",
                    lineHeight: 1.5,
                  }}
                >
                  · {point}
                </span>
              ))}
            </div>
          </FadeIn>
        ))}
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 88,
            height: 88,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: "color-mix(in srgb, var(--glint-color-surface) 88%, transparent)",
            boxShadow: "var(--glint-shadow-card)",
            fontFamily: "var(--glint-font-display)",
            fontSize: 28,
            letterSpacing: "0.06em",
            color: "var(--glint-color-text-muted)",
          }}
        >
          VS
        </span>
      </div>
    </>
  );
};
