import type { TitleScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";

export const TitleSceneView: React.FC<{ scene: TitleScene }> = ({ scene }) => {
  return (
    <>
      <FadeIn>
        <div
          style={{
            width: 96,
            height: 8,
            borderRadius: 999,
            background:
              "linear-gradient(90deg, var(--glint-color-accent), var(--glint-color-accent-2))",
          }}
        />
      </FadeIn>
      <FadeIn delay={6}>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--glint-font-display)",
            fontSize: "var(--glint-font-size-display)",
            fontWeight: 700,
            lineHeight: 1.18,
            background:
              "linear-gradient(115deg, var(--glint-color-text) 38%, var(--glint-color-accent) 72%, var(--glint-color-accent-2) 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          {scene.title}
        </h1>
      </FadeIn>
      {scene.subtitle ? (
        <FadeIn delay={14}>
          <p
            style={{
              margin: 0,
              fontSize: "var(--glint-font-size-h2)",
              color: "var(--glint-color-text-muted)",
              lineHeight: 1.5,
            }}
          >
            {scene.subtitle}
          </p>
        </FadeIn>
      ) : null}
    </>
  );
};
