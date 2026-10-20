import type { BulletsScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";
import { Heading } from "../components/Heading";

export const BulletsSceneView: React.FC<{ scene: BulletsScene }> = ({
  scene,
}) => {
  return (
    <>
      {scene.heading ? (
        <FadeIn>
          <Heading>{scene.heading}</Heading>
        </FadeIn>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
        {scene.items.map((item, index) => (
          <FadeIn key={item} delay={8 + index * 6}>
            <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
              <span
                style={{
                  minWidth: 68,
                  height: 68,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "var(--glint-radius)",
                  fontFamily: "var(--glint-font-mono)",
                  fontSize: 26,
                  letterSpacing: "0.06em",
                  color: "var(--glint-color-accent)",
                  background:
                    "color-mix(in srgb, var(--glint-color-accent) 12%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--glint-color-accent) 26%, transparent)",
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                style={{
                  fontSize: "var(--glint-font-size-body)",
                  lineHeight: 1.55,
                }}
              >
                {item}
              </span>
            </div>
          </FadeIn>
        ))}
      </div>
    </>
  );
};
