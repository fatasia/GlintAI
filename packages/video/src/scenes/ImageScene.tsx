import { LocalAssetPath, type ImageScene } from "@glintai/scenescript";
import { AbsoluteFill, Img, staticFile, useVideoConfig } from "remotion";
import { FadeIn } from "../components/FadeIn";

const IMAGE_LAYOUT = {
  topPadding: 150,
  bottomPadding: 330,
  captionGap: 44,
  captionReserve: 136,
  imageHeightRatio: 420 / 1080,
} as const;

/** Framed local asset with separate, non-shrinking image and caption rows. */
export const ImageSceneView: React.FC<{ scene: ImageScene }> = ({ scene }) => {
  const { width, height } = useVideoConfig();
  const topPadding = Math.min(IMAGE_LAYOUT.topPadding, height * 0.14);
  const bottomPadding = Math.min(IMAGE_LAYOUT.bottomPadding, height * 0.31);
  const captionSpace = scene.caption ? IMAGE_LAYOUT.captionGap + IMAGE_LAYOUT.captionReserve : 0;
  const imageHeight = Math.max(1, Math.min(
    height * IMAGE_LAYOUT.imageHeightRatio,
    height - topPadding - bottomPadding - captionSpace,
  ));
  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: IMAGE_LAYOUT.captionGap,
        padding: `${topPadding}px ${Math.min(170, width * 0.09)}px ${bottomPadding}px`,
        boxSizing: "border-box",
      }}
    >
      <FadeIn style={{ width: "100%", maxWidth: 1400, height: imageHeight, flexShrink: 0 }}>
        <Img
          src={staticFile(LocalAssetPath.parse(scene.src))}
          alt={scene.caption ?? "Project image"}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            maxWidth: "100%",
            maxHeight: "100%",
            boxSizing: "border-box",
            objectFit: "contain",
            borderRadius: "var(--glint-radius)",
            boxShadow: "var(--glint-shadow-card)",
            border: "1px solid color-mix(in srgb, var(--glint-color-text) 10%, transparent)",
          }}
        />
      </FadeIn>
      {scene.caption ? (
        <FadeIn delay={8} style={{ width: "100%", maxWidth: 1400, flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: "var(--glint-font-size-body)",
              color: "var(--glint-color-text-muted)",
              textAlign: "center",
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}
          >
            {scene.caption}
          </p>
        </FadeIn>
      ) : null}
    </AbsoluteFill>
  );
};
