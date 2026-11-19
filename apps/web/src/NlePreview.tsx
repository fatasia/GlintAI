import { useEffect, useRef, useState } from "react";
import { renderNleFrame, type NleFrameHost } from "@glintai/video/nle-dom";
import type { NleProject } from "@glintai/scenescript";
import { createPreviewAudioMeter, METER_FLOOR_DB, type PreviewAudioMeter } from "./preview-audio-meter";
import { safeAreaInsets, SafeAreaOverlay } from "./nle-safe-area";

const DB_FLOOR = METER_FLOOR_DB;

/** Release removed media; a later undo creates a fresh element and audio node. */
function pruneMedia(host: NleFrameHost, project: NleProject, meter: PreviewAudioMeter | null): void {
  const valid = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.kind === "audio") valid.add(`aud:${track.id}:${clip.id}`);
    if (clip.kind === "video") valid.add(`vid:${clip.id}`);
  }
  for (const [key, element] of host.media ?? []) if (!valid.has(key)) {
    element.pause(); element.removeAttribute("src"); element.load(); element.remove();
    host.media!.delete(key); host.targets?.delete(key);
  }
  meter?.retainElements([...(host.media?.values() ?? [])]);
  meter?.retainTracks(project.tracks.map(track => track.id));
}

/**
 * Frame-accurate NLE preview. Renders the same DOM contract the renderer
 * screenshots, driven by requestAnimationFrame; no separate preview engine,
 * so what you see is what ffmpeg encodes. While playing, pooled media elements
 * route through a shared Web Audio graph that also meters the stereo mix —
 * meter bars are written straight to the DOM, never through React state.
 */
export function NlePreview({ project, mediaAssetBase, tMs, playing, muted = false, showMeter = true, showSafeArea = false, onTimeUpdate, onEnded, onTrackLevels }: {
  project: NleProject;
  mediaAssetBase: string;
  tMs: number;
  playing: boolean;
  muted?: boolean;
  showMeter?: boolean;
  showSafeArea?: boolean;
  onTimeUpdate?(ms: number): void;
  onEnded?(): void;
  onTrackLevels?(levels: Record<string, number>): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const hostRef = useRef<NleFrameHost | null>(null);
  const stateRef = useRef({ project, tMs, playing, muted, onTimeUpdate, onEnded, onTrackLevels });
  stateRef.current = { project, tMs, playing, muted, onTimeUpdate, onEnded, onTrackLevels };
  const meterRef = useRef<PreviewAudioMeter | null>(null);
  const barRef = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({ left: null, right: null });
  const writeBars = (left: number, right: number) => {
    for (const [key, db] of [["left", left], ["right", right]] as const) {
      const bar = barRef.current[key];
      if (!bar) continue;
      const fraction = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
      bar.style.height = `${fraction * 100}%`;
      bar.style.background = db > -1 ? "var(--danger)" : db > -12 ? "var(--warn)" : "#34d399";
    }
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    hostRef.current ??= { root, resolveAsset: src => `${stateRef.current.project ? mediaAssetBase : ""}${src.slice("assets/".length)}` };
    hostRef.current.resolveAsset = src => `${mediaAssetBase}${src.slice("assets/".length)}`;
  }, [mediaAssetBase]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // Contain within the available box: editors wrap the preview in a
    // height-constrained pane, and an aspect-ratio box alone overflows it
    // (the picture bottom — and anything pinned there — gets clipped).
    const measure = () => {
      const parent = frame.parentElement;
      const width = parent?.clientWidth || frame.clientWidth || 1;
      const availHeight = parent?.clientHeight || 0;
      const next = Math.min(width / project.width, availHeight > 0 ? availHeight / project.height : Number.POSITIVE_INFINITY);
      setScale(next === Number.POSITIVE_INFINITY ? width / project.width : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (frame.parentElement) observer.observe(frame.parentElement);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [project.width, project.height]);

  useEffect(() => () => {
    // Release media elements and close the meter graph when the editor unmounts.
    const host = hostRef.current;
    for (const element of host?.media?.values() ?? []) {
      element.pause();
      element.removeAttribute("src");
    }
    void meterRef.current?.close().catch(() => {});
    meterRef.current = null;
    host?.root.replaceChildren();
    hostRef.current = null;
  }, []);

  useEffect(() => {
    const host = hostRef.current, root = rootRef.current;
    if (!host || !root) return;
    if (!playing) {
      renderNleFrame(host, project, tMs, { playing: false, muted });
      pruneMedia(host, project, meterRef.current);
      writeBars(DB_FLOOR, DB_FLOOR);
      stateRef.current.onTrackLevels?.({});
      return;
    }
    let raf = 0;
    const anchor = performance.now(), base = tMs;
    if (muted) { for (const track of project.tracks) meterRef.current?.setTrackEnabled(track.id, false); writeBars(DB_FLOOR, DB_FLOOR); stateRef.current.onTrackLevels?.({}); }
    let meter: PreviewAudioMeter | null = null;
    if (!muted && typeof AudioContext !== "undefined") {
      try {
        meterRef.current ??= createPreviewAudioMeter(new AudioContext());
        meter = meterRef.current;
        void meter.resume().catch(() => {});
      } catch { /* Unsupported Web Audio must not prevent direct media playback. */ }
    }
    if (!meter) stateRef.current.onTrackLevels?.({});
    const tick = (now: number) => {
      const current = stateRef.current;
      const nextMs = base + (now - anchor);
      const total = Math.max(...current.project.tracks.map(track => track.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0)), 1);
      if (nextMs >= total) {
        renderNleFrame(host, current.project, total, { playing: false, muted: current.muted });
        writeBars(DB_FLOOR, DB_FLOOR);
        current.onTrackLevels?.({});
        current.onEnded?.();
        return;
      }
      renderNleFrame(host, current.project, nextMs, { playing: true, muted: current.muted });
      pruneMedia(host, current.project, meter);
      if (meter && host.media) {
        const tracks = current.project.tracks;
        const videoTracks = new Map(tracks.flatMap(track => track.clips.filter(clip => clip.kind === "video").map(clip => [clip.id, track.id] as const)));
        for (const [key, element] of host.media) {
          const trackId = key.startsWith("aud:") ? key.split(":")[1] : key.startsWith("vid:") ? videoTracks.get(key.slice(4)) : undefined;
          if (!trackId || !tracks.some(track => track.id === trackId)) continue;
          try { meter.attach(element, trackId); } catch { /* A failed capture must not break the timeline clock. */ }
        }
        const solo = tracks.some(track => track.solo);
        for (const track of tracks) meter.setTrackEnabled(track.id, !current.muted && !track.muted && (!solo || Boolean(track.solo)));
        const levels = meter.sample();
        writeBars(levels.left, levels.right);
        current.onTrackLevels?.(meter.isActive() ? Object.fromEntries(tracks.map(track => [track.id, meter!.sampleTrack(track.id)])) : {});
      }
      current.onTimeUpdate?.(nextMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [project, tMs, playing, muted]);

  return <div ref={frameRef} style={{ position: "relative", width: Math.round(project.width * scale), height: Math.round(project.height * scale), margin: "0 auto", background: "#000", overflow: "hidden" }}>
    <div ref={rootRef} style={{ position: "absolute", top: 0, left: 0, width: project.width, height: project.height, transform: `scale(${scale})`, transformOrigin: "top left" }} />
    {showSafeArea && <SafeAreaOverlay insets={safeAreaInsets(project)} />}
    {showMeter && <div aria-label="音频电平表" title="预览混音电平（dBFS）" style={{ position: "absolute", right: 10, top: 10, display: "flex", gap: 4, alignItems: "flex-end", height: 56, padding: 4, borderRadius: 7, background: "#131318ee", border: "1px solid var(--line-3)", boxShadow: "0 2px 8px #00000066" }}>
      {(["left", "right"] as const).map(channel => <div key={channel} style={{ position: "relative", width: 7, height: "100%", borderRadius: 3, background: "var(--ink-3)", overflow: "hidden" }}>
        <div ref={element => { barRef.current[channel] = element; }} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "0%", borderRadius: 3, background: "#34d399" }} />
      </div>)}
    </div>}
  </div>;
}
