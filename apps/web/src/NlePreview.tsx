import { useEffect, useRef, useState } from "react";
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
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
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
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth || 1;
      setScale(width / project.width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [project.width]);

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

  return <div ref={frameRef} style={{ position: "relative", width: "100%", aspectRatio: `${project.width} / ${project.height}`, background: "#000", overflow: "hidden" }}>
    <div ref={rootRef} style={{ position: "absolute", top: 0, left: 0, width: project.width, height: project.height, transform: `scale(${scale})`, transformOrigin: "top left" }} />
  </div>;
}
