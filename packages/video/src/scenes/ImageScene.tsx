import { sceneDurationMs, type ImageScene } from "@glintai/scenescript";
import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import { useMediaAssetSrc } from "../components/MediaAssetContext";
import { imageSceneLayout, shouldShowImageCaption, showcaseForegroundTransform } from "./image-layout";

/** The layout and depth transform are shared with the independent exporter. */
export const ImageSceneView: React.FC<{ scene: ImageScene }> = ({ scene }) => {
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame(), src = useMediaAssetSrc(scene.src);
  const styles = imageSceneLayout(scene, width, height);
  const duration = Math.max(1, Math.round(sceneDurationMs(scene) / 1000 * fps));
  return <div style={styles.container}>
    {styles.background && <Img src={src} alt="" aria-hidden style={styles.background} />}
    {styles.veil && <div style={styles.veil} />}
    <div style={{ ...styles.frame, transform: showcaseForegroundTransform(scene, frame, duration, Math.min(width, height) / 1080) }}>
      <Img src={src} alt={scene.caption ?? "Project image"} style={styles.image} />
    </div>
    {shouldShowImageCaption(scene) && <p style={styles.caption}>{scene.caption}</p>}
  </div>;
};
