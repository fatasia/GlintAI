import { useId, type ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { effectFilterSvg, type SceneEffect } from "@glintai/scenescript";

/** Same SVG primitives as native output; affects the complete scene, never the audio clock. */
export function SceneEffects({ effects, composited = false, children }: { effects?: SceneEffect[]; composited?: boolean; children: ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const frame = useCurrentFrame(), { fps } = useVideoConfig();
  const filter = effectFilterSvg(effects ?? [], frame / fps * 1000, `preview-${id || "root"}`);
  if (!filter.defs) return <>{children}</>;
  return <>
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: filter.defs }} />
    <AbsoluteFill style={{ background: "var(--glint-color-bg)", filter: composited ? "none" : filter.filter }}>
      {children}
      {composited && <AbsoluteFill style={{ pointerEvents: "none", backdropFilter: filter.filter }} />}
    </AbsoluteFill>
  </>;
}
