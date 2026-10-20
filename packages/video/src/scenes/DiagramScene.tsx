import type { DiagramScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";
import { Heading } from "../components/Heading";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { estimateNarrationDurationMs } from "@glintai/scenescript";

/** Horizontal flow diagram: 2-5 labeled nodes joined by soft arrows. */
export const DiagramSceneView: React.FC<{ scene: DiagramScene }> = ({
  scene,
}) => {
  const { width, height, fps } = useVideoConfig(), frame = useCurrentFrame();
  const narrow = width / height < 1.3;
  const square = narrow && width / height > 0.9;
  const duration = scene.narration.durationMs ?? estimateNarrationDurationMs(scene.narration.text);
  const active = Math.min(scene.steps.length - 1, Math.floor(frame / fps * 1000 / Math.max(1, duration) * scene.steps.length));
  return (
    <>
      {scene.heading ? (
        <FadeIn>
          <Heading>{scene.heading}</Heading>
        </FadeIn>
      ) : null}
      <FadeIn delay={6} style={{ width: "100%" }}>
        <div
          style={{
            display: square ? "grid" : "flex",
            gridTemplateColumns: square ? "repeat(2, minmax(0, 1fr))" : undefined,
            flexDirection: narrow ? "column" : "row",
            alignItems: "stretch",
            gap: 24,
            width: "100%",
          }}
        >
          {scene.steps.map((step, index) => (
            <div
              key={`${index}-${step.label}`}
              style={{ display: "flex", flexDirection: narrow ? "column" : "row", alignItems: "stretch", gap: 24, flex: 1, minWidth: 0 }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  background:
                    "linear-gradient(180deg, color-mix(in srgb, var(--glint-color-accent) 8%, var(--glint-color-surface)), var(--glint-color-surface))",
                  border: "var(--glint-line-hairline)",
                  borderTop: `6px solid ${index === scene.steps.length - 1 ? "var(--glint-color-accent-2)" : "var(--glint-color-accent)"}`,
                  borderRadius: "var(--glint-radius)",
                  boxShadow:
                    "var(--glint-shadow-card), var(--glint-shadow-inner-highlight)",
                  padding: "34px 30px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--glint-font-size-body)",
                    fontWeight: 700,
                    lineHeight: 1.4,
                  }}
                >
                  {square ? `${index + 1}. ` : ""}{step.label}
                </span>
                {step.note && (!square || index === active) ? (
                  <span
                    style={{
                      fontSize: "var(--glint-font-size-caption)",
                      lineHeight: 1.45,
                      color: "var(--glint-color-text-muted)",
                    }}
                  >
                    {step.note}
                  </span>
                ) : null}
              </div>
              {!square && index < scene.steps.length - 1 ? (
                <span
                  style={{
                    fontSize: 44,
                    color: "var(--glint-color-text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {narrow ? "↓" : "→"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </FadeIn>
      {scene.caption ? (
        <FadeIn delay={12}>
          <p
            style={{
              margin: 0,
              fontSize: "var(--glint-font-size-body)",
              color: "var(--glint-color-text-muted)",
            }}
          >
            {scene.caption}
          </p>
        </FadeIn>
      ) : null}
    </>
  );
};
