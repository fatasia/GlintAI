import { useEffect, useRef } from "react";
import { renderNleFrame, type NleFrameHost } from "@glintai/video/nle-dom";
import type { NleProject } from "@glintai/scenescript";

/**
 * Frame-accurate NLE preview. Renders the same DOM contract the renderer
 * screenshots, driven by requestAnimationFrame; no separate preview engine,
 * so what you see is what ffmpeg encodes.
 */
export function NlePreview({ project, mediaAssetBase, tMs, playing, muted = false, onTimeUpdate, onEnded }: {
  project: NleProject;
  mediaAssetBase: string;
  tMs: number;
  playing: boolean;
  muted?: boolean;
  onTimeUpdate?(ms: number): void;
  onEnded?(): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<NleFrameHost | null>(null);
  const stateRef = useRef({ project, tMs, playing, muted, onTimeUpdate, onEnded });
  stateRef.current = { project, tMs, playing, muted, onTimeUpdate, onEnded };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    hostRef.current ??= { root, resolveAsset: src => `${stateRef.current.project ? mediaAssetBase : ""}${src.slice("assets/".length)}` };
    hostRef.current.resolveAsset = src => `${mediaAssetBase}${src.slice("assets/".length)}`;
  }, [mediaAssetBase]);

  useEffect(() => {
    const host = hostRef.current, root = rootRef.current;
    if (!host || !root) return;
    if (!playing) {
      renderNleFrame(host, project, tMs, { playing: false, muted });
      return;
    }
    let raf = 0;
    let anchor = performance.now();
    let base = tMs;
    const tick = (now: number) => {
      const current = stateRef.current;
      const nextMs = base + (now - anchor);
      const total = Math.max(...current.project.tracks.map(track => track.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0)), 1);
      if (nextMs >= total) {
        renderNleFrame(host, current.project, total, { playing: false, muted: current.muted });
        current.onEnded?.();
        return;
      }
      renderNleFrame(host, current.project, nextMs, { playing: true, muted: current.muted });
      current.onTimeUpdate?.(nextMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [project, tMs, playing, muted]);

  useEffect(() => () => {
    // Release media elements when the editor unmounts.
    const host = hostRef.current;
    for (const element of host?.media?.values() ?? []) {
      element.pause();
      element.removeAttribute("src");
    }
  }, []);

  const scale = 1;
  return <div style={{ position: "relative", width: "100%", aspectRatio: `${project.width} / ${project.height}`, background: "#000", overflow: "hidden" }}>
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
      <div style={{ position: "relative", maxWidth: "100%", maxHeight: "100%", width: project.width >= project.height ? "100%" : "auto", height: project.width >= project.height ? "auto" : "100%" }}>
        <div ref={rootRef} style={{ position: "absolute", inset: 0, transformOrigin: "top left", containerType: "size" }} />
      </div>
    </div>
    <span hidden>{scale}</span>
  </div>;
}
