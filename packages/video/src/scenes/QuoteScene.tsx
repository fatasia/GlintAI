import type { QuoteScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";

export const QuoteSceneView: React.FC<{ scene: QuoteScene }> = ({ scene }) => {
  return (
    <>
      <FadeIn>
        <span
          style={{
            display: "block",
            height: 96,
            fontSize: 190,
            lineHeight: 1,
            fontFamily: "var(--glint-font-display)",
            fontWeight: 700,
            color: "var(--glint-color-accent-2)",
            opacity: 0.45,
          }}
        >
          “
        </span>
      </FadeIn>
      <FadeIn delay={6}>
        <p
          style={{
            margin: 0,
            maxWidth: 1500,
            fontSize: "var(--glint-font-size-h1)",
            lineHeight: 1.55,
            fontFamily: "var(--glint-font-display)",
            fontWeight: 600,
          }}
        >
          {scene.text}
        </p>
      </FadeIn>
      {scene.attribution ? (
        <FadeIn delay={12}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              fontSize: "var(--glint-font-size-body)",
              color: "var(--glint-color-text-muted)",
            }}
          >
            <span
              style={{
                width: 48,
                height: 6,
                borderRadius: 999,
                background:
                  "linear-gradient(90deg, var(--glint-color-accent), var(--glint-color-accent-2))",
              }}
            />
            {scene.attribution}
          </div>
        </FadeIn>
      ) : null}
    </>
  );
};
