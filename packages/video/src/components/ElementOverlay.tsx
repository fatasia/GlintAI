import type { Scene } from "@glintai/scenescript";
import { evaluateElements } from "@glintai/scenescript";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Renders the editable object layer above a scene. The SVG renderer uses the
 * same `evaluateElements`, so both backends agree at a given millisecond.
 */
export const ElementOverlay: React.FC<{ scene: Scene; timeMs: number }> = ({ scene, timeMs }) => {
  const states = evaluateElements(scene, timeMs);
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
              background: element.fill,
              borderRadius: element.radius ?? 0,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Remotion wrapper that supplies composition time from the current frame. */
export const SceneElements: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <ElementOverlay scene={scene} timeMs={(frame / fps) * 1000} />;
};
