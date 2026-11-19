import type { Scene } from "@glintai/scenescript";
import { BRUSH_PATHS, evaluateMorphElements, strokePathAt, strokeProgress } from "@glintai/scenescript";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Renders the editable object layer above a scene. The SVG renderer uses the
 * same `evaluateElements`, so both backends agree at a given millisecond.
 */
export const ElementOverlay: React.FC<{ scene: Scene; previousScene?: Scene; timeMs: number; size?: number }> = ({ scene, previousScene, timeMs, size = 1 }) => {
  const states = evaluateMorphElements(scene, previousScene, timeMs);
  if (!states.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {states.map(state => {
        const { element } = state;
        const transform = `translate(-50%, -50%) rotate(${state.rotate}deg) scale(${state.scale})`;
        if (element.kind === "text") {
          return (
            <div
              key={element.id}
              style={{
                position: "absolute",
                left: `${state.x * 100}%`,
                top: `${state.y * 100}%`,
                transform,
                opacity: state.opacity,
                color: element.color ?? "var(--glint-color-text)",
                fontSize: element.fontSize ?? 48,
                fontWeight: element.weight ?? 700,
                textAlign: element.align ?? "center",
                whiteSpace: "pre-wrap",
                lineHeight: 1.15,
              }}
            >
              {element.text}
            </div>
          );
        }
        if (element.kind === "path") return <svg key={element.id} aria-hidden="true" viewBox={`0 0 ${element.viewBox.join(" ")}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", left: `${state.x * 100}%`, top: `${state.y * 100}%`, width: `${element.w * 100}%`, height: `${element.h * 100}%`, transform, opacity: state.opacity }}><path d={scene.transition?.in === "shape-morph" && previousScene?.elements?.some(source => source.id === element.id && source.kind === "path") ? element.d : strokePathAt(element.d, strokeProgress(element, timeMs))} fill="none" stroke={element.stroke} strokeWidth={element.strokeWidth} strokeLinecap="round" strokeLinejoin="round" /></svg>;
        return (
          <div
            key={element.id}
            style={{
              position: "absolute",
              left: `${state.x * 100}%`,
              top: `${state.y * 100}%`,
              width: `${element.w * 100}%`,
              height: `${element.h * 100}%`,
              transform,
              opacity: state.opacity,
              background: element.appearance === "brush" ? "transparent" : element.fill,
              borderRadius: element.appearance === "brush" ? 0 : (element.radius ?? 0) * size,
            }}
          >{element.appearance === "brush" && <svg aria-hidden="true" viewBox="0 0 1000 100" preserveAspectRatio="none" width="100%" height="100%">{BRUSH_PATHS.map(path => <path key={path.d} d={path.d} fill={element.fill} opacity={path.opacity} />)}</svg>}</div>
        );
      })}
    </AbsoluteFill>
  );
};

/** Remotion wrapper that supplies composition time from the current frame. */
export const SceneElements: React.FC<{ scene: Scene; previousScene?: Scene }> = ({ scene, previousScene }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  return <ElementOverlay scene={scene} previousScene={previousScene} timeMs={(frame / fps) * 1000} size={Math.min(width, height) / 1080} />;
};
