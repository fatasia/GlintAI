import type { DefinitionScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";

export const DefinitionSceneView: React.FC<{ scene: DefinitionScene }> = ({
  scene,
}) => {
  return (
    <FadeIn>
      <div
        style={{
          borderLeft: "10px solid transparent",
          borderImage:
            "linear-gradient(180deg, var(--glint-color-accent), var(--glint-color-accent-2)) 1",
          paddingLeft: 68,
          display: "flex",
          flexDirection: "column",
          gap: 44,
          maxWidth: 1500,
        }}
      >
        <span
          style={{
            fontSize: "var(--glint-font-size-h1)",
            fontFamily: "var(--glint-font-display)",
            fontWeight: 700,
            color: "var(--glint-color-accent)",
            lineHeight: 1.2,
          }}
        >
          {scene.term}
        </span>
        <p
          style={{
            margin: 0,
            fontSize: "var(--glint-font-size-h2)",
            lineHeight: 1.65,
          }}
        >
          {scene.definition}
        </p>
      </div>
    </FadeIn>
  );
};
