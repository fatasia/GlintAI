import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NlePreview } from "./NlePreview";
import {
  nleAddTrack, nleDurationMs, nleMoveClip, nleRemoveClip, nleRemoveTrack, nleSnap, nleSnapPoints, nleSplitClip, nleTrimClip, nleTransitionProgress,
  parseNleProject, type NleClip, type NleProject, type NleTrack,
} from "@glintai/scenescript";

const STORAGE = "glint.nle.project.v2";
const DEFAULT_FADE_MS = 500;
const SNAP_PX = 8;
const MAX_HISTORY = 80;
const text = { color: "#e4e4e7", background: "#151518", border: "1px solid #2b2b31", borderRadius: 7, padding: "6px 8px", font: "inherit", fontSize: 12 } as const;
const button: CSSProperties = { border: "1px solid #3f3f46", borderRadius: 8, background: "#1c1c21", color: "#e4e4e7", padding: "7px 11px", font: "inherit", fontSize: 12, cursor: "pointer" };
const label: CSSProperties = { display: "grid", gap: 4, color: "#a1a1aa", fontSize: 11, minWidth: 0 };
const DEFAULT_TRACKS: Array<{ id: string; kind: NleTrack["kind"]; name: string }> = [
  { id: "v2", kind: "overlay", name: "V2 叠加" },
  { id: "v1", kind: "video", name: "V1 主画面" },
  { id: "t1", kind: "text", name: "T1 文字" },
  { id: "a1", kind: "audio", name: "A1 音频" },
];
const TRACK_ROW_H = 38;
const TRACK_KINDS: Array<{ kind: NleTrack["kind"]; label: string }> = [
  { kind: "video", label: "+ 视频轨" },
  { kind: "overlay", label: "+ 叠加轨" },
  { kind: "text", label: "+ 文字轨" },
  { kind: "audio", label: "+ 音频轨" },
];
const TRANSITIONS = [{ value: "", label: "无" }, { value: "fade", label: "淡入淡出" }, { value: "slide", label: "滑入" }, { value: "zoom", label: "缩放" }, { value: "wipe", label: "擦除" }] as const;

type Asset = { name: string; url: string; bytes: number };
type Selection = { trackId: string; clipId: string };
type ClipTransitionType = NonNullable<NleClip["transitionIn"]>["type"];

function defaultProject(): NleProject {
  return parseNleProject({
    schemaVersion: 1, id: "nle-local", title: "未命名剪辑", fps: 30, width: 1920, height: 1080, background: "#08090b",
    tracks: DEFAULT_TRACKS.map(track => ({ ...track, clips: track.id === "t1" ? [{ id: "title", kind: "text", text: "双击时间线开始剪辑", startMs: 0, durationMs: 3000, fontSize: 84, weight: 800, align: "center" }] : [] })),
  });
}

function kindOf(name: string): "image" | "video" | "audio" | null {
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "image";
  if (/\.mp4$/i.test(name)) return "video";
  if (/\.(mp3|wav)$/i.test(name)) return "audio";
  return null;
}

function withTracks(project: NleProject, update: (tracks: NleTrack[]) => NleTrack[]): NleProject {
  return parseNleProject({ ...project, tracks: update(project.tracks) });
}

function clipStyle(clip: NleClip): CSSProperties {
  const color = clip.kind === "audio" ? "#1f6f5c" : clip.kind === "text" ? "#5b4b8a" : clip.kind === "image" ? "#2f5d8a" : "#7a4b2a";
  return { position: "absolute", top: 3, bottom: 3, left: 0, width: "100%", background: color, border: "1px solid #ffffff22", borderRadius: 6, color: "#fff", fontSize: 10, textAlign: "left", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "grab", userSelect: "none" };
}

const peaksCache = new Map<string, number[] | null>();
function useWaveformPeaks(src: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => src ? peaksCache.get(src) ?? null : null);
  useEffect(() => {
    if (!src) { setPeaks(null); return; }
    if (peaksCache.has(src)) { setPeaks(peaksCache.get(src) ?? null); return; }
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { peaksCache.set(src, null); setPeaks(null); return; }
    let cancelled = false;
    const context = new AudioContextClass();
    void fetch(src).then(response => response.arrayBuffer()).then(buffer => context.decodeAudioData(buffer)).then(audio => {
      const data = audio.getChannelData(0), bars = 80, result = Array.from({ length: bars }, (_, index) => {
        const from = Math.floor(index / bars * data.length), to = Math.max(from + 1, Math.floor((index + 1) / bars * data.length));
        let peak = 0;
        for (let i = from; i < Math.min(to, data.length); i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
        return peak;
      });
      const loudest = Math.max(...result, 0.0001), normalized = result.map(peak => peak / loudest);
      peaksCache.set(src, normalized);
      if (!cancelled) setPeaks(normalized);
    }).catch(() => { peaksCache.set(src, null); if (!cancelled) setPeaks(null); }).finally(() => { void context.close(); });
    return () => { cancelled = true; };
  }, [src]);
  return peaks;
}

function ClipWaveform({ src }: { src: string | null }) {
  const peaks = useWaveformPeaks(src);
  if (!peaks) return null;
  const points = peaks.map((peak, index) => `${(index / (peaks.length - 1)) * 100},${12 - peak * 10}`).join(" ");
  return <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" style={{ position: "absolute", inset: "4px 2px", width: "calc(100% - 4px)", height: "calc(100% - 8px)", opacity: 0.75, pointerEvents: "none" }}>
    <polyline points={points} fill="none" stroke="#a7f3d0" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
  </svg>;
}

/**
 * Desktop multi-track editor. Preview and MP4 export run the same Remotion
 * composition, so what the timeline shows is what the renderer encodes.
 * v2 adds waveforms, snapping, undo/redo, multi-select, edge transitions and a
 * timeline export that does not require re-rendering.
 */
export function NleEditor({ onClose }: { onClose?(): void }) {
  const [project, setProject] = useState<NleProject>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE) ?? localStorage.getItem("glint.nle.project.v1") ?? "null");
      return parseNleProject(stored);
    } catch { return defaultProject(); }
  });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerMs, setPxPerMs] = useState(0.08);
  const [snap, setSnap] = useState(true);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState<"fcpxml" | "edl" | null>(null);
  const [result, setResult] = useState<{ url: string; file: string } | null>(null);
  const [timelineResult, setTimelineResult] = useState<{ url: string; file: string; clips: number; textClips: number; warning?: string } | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const undoStack = useRef<NleProject[]>([]);
  const redoStack = useRef<NleProject[]>([]);
  const projectRef = useRef(project);
  projectRef.current = project;
  const drag = useRef<{ startX: number; snapshot: NleProject; primary: Selection; selected: Selection[]; edge?: "start" | "end" } | null>(null);
  const fieldSnapshot = useRef<NleProject | null>(null);
  const ruler = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const duration = nleDurationMs(project);
  const primary = selection.at(-1) ?? null;
  const primaryClip = useMemo(() => {
    if (!primary) return null;
    const track = project.tracks.find(item => item.id === primary.trackId);
    const clip = track?.clips.find(item => item.id === primary.clipId);
    return track && clip ? { track, clip } : null;
  }, [project, primary]);
  const selectedIds = useMemo(() => new Set(selection.map(item => item.clipId)), [selection]);
  const audioAssets = useMemo(() => {
    const map = new Map<string, string>();
    for (const track of project.tracks) for (const clip of track.clips) if (clip.kind === "audio") map.set(clip.id, `${"/api/media/assets/"}${clip.src.slice("assets/".length)}`);
    return map;
  }, [project]);

  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(project)); } catch { /* Storage is optional. */ } }, [project]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/media/library", { signal: controller.signal }).then(response => response.json()).then(data => {
      if (Array.isArray(data.assets)) setAssets(data.assets.filter((asset: Asset) => kindOf(asset.name)));
    }).catch(() => setError("素材库读取失败；仍可编辑文字轨和已保存工程。"));
    return () => controller.abort();
  }, []);

  const mutate = useCallback((next: NleProject, history = true) => {
    const current = projectRef.current;
    if (history && next !== current) {
      undoStack.current.push(current);
      if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
      redoStack.current = [];
    }
    projectRef.current = next;
    setProject(next);
    setHistoryTick(value => value + 1);
    setError("");
  }, []);
  /** Inspector fields edit live but commit one undo entry when the field loses focus. */
  const beginField = () => { fieldSnapshot.current ??= projectRef.current; };
  const endField = () => {
    const snapshot = fieldSnapshot.current; fieldSnapshot.current = null;
    if (!snapshot || snapshot === projectRef.current) return;
    undoStack.current.push(snapshot);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setHistoryTick(value => value + 1);
  };
  const local = (next: NleProject) => { projectRef.current = next; setProject(next); setError(""); };
  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(projectRef.current);
    projectRef.current = previous;
    setProject(previous);
    setHistoryTick(value => value + 1);
  }, []);
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(projectRef.current);
    projectRef.current = next;
    setProject(next);
    setHistoryTick(value => value + 1);
  }, []);
  const seek = useCallback((ms: number) => {
    const value = Math.max(0, Math.round(ms));
    setPlayhead(value);
    if (playing) setPlaying(false);
  }, [project.fps]);
  /** First unlocked track accepting the clip kind; a new track appears when none fits. */
  const targetTrack = (accepts: (kind: NleTrack["kind"]) => boolean): { project: NleProject; track: NleTrack } | null => {
    const existing = project.tracks.find(track => accepts(track.kind) && !track.locked);
    if (existing) return { project, track: existing };
    if (project.tracks.length >= 8) return null;
    const kind: NleTrack["kind"] = accepts("audio") ? "audio" : accepts("text") ? "text" : accepts("video") ? "video" : "overlay";
    const next = nleAddTrack(project, kind);
    return { project: next, track: next.tracks.at(-1)! };
  };
  const addAsset = (asset: Asset) => {
    const kind = kindOf(asset.name); if (!kind) return;
    const found = targetTrack(trackKind => kind === "audio" ? trackKind === "audio" : trackKind === "video" || trackKind === "overlay");
    if (!found) { setError("轨道已达 8 条上限。"); return; }
    const track = found.track;
    const start = kind === "audio" ? 0 : Math.max(playhead, ...track.clips.map(clip => clip.startMs + clip.durationMs));
    const clip = { id: `clip-${crypto.randomUUID().slice(0, 8)}`, kind, src: `assets/${asset.name}`, startMs: start, durationMs: kind === "video" ? 5000 : 3000, ...(kind === "audio" ? { volume: 0.25 } : {}), transitionIn: { type: "fade" } } as NleClip;
    mutate(withTracks(found.project, tracks => tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item)));
    setSelection([{ trackId: track.id, clipId: clip.id }]); seek(start);
  };
  const addText = () => {
    const found = targetTrack(kind => kind === "text");
    if (!found) { setError("轨道已达 8 条上限。"); return; }
    const track = found.track;
    const clip: NleClip = { id: `txt-${crypto.randomUUID().slice(0, 8)}`, kind: "text", text: "新文字", startMs: playhead, durationMs: 2500, fontSize: 72, weight: 800, align: "center", transitionIn: { type: "fade" } };
    mutate(withTracks(found.project, tracks => tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item)));
    setSelection([{ trackId: track.id, clipId: clip.id }]);
  };
  const addTrack = (kind: NleTrack["kind"]) => {
    if (project.tracks.length >= 8) { setError("轨道已达 8 条上限。"); return; }
    mutate(nleAddTrack(project, kind));
  };
  const removeTrack = (trackId: string) => {
    const track = project.tracks.find(item => item.id === trackId);
    if (!track) return;
    if (track.clips.length && !confirm(`删除「${track.name}」及其 ${track.clips.length} 个片段？Ctrl+Z 可撤销。`)) return;
    mutate(nleRemoveTrack(project, trackId));
    setSelection(current => current.filter(item => item.trackId !== trackId));
  };
  const removeSelected = () => {
    if (!selection.length) return;
    let next = project;
    for (const item of selection) {
      const track = next.tracks.find(candidate => candidate.id === item.trackId);
      if (track?.locked) continue;
      next = nleRemoveClip(next, item.trackId, item.clipId);
    }
    if (next !== project) { mutate(next); setSelection([]); }
  };
  const split = () => {
    if (!primary || !primaryClip || primaryClip.track.locked) return;
    try {
      const next = nleSplitClip(project, primary.trackId, primary.clipId, playhead);
      if (next === project) { setError("播放头需要落在片段内部（留出至少 100ms）。"); return; }
      mutate(next); setStatus("已在播放头切分");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "切分失败"); }
  };
  const duplicate = () => {
    if (!primary || !primaryClip || primaryClip.track.locked) return;
    const copy = { ...primaryClip.clip, id: `${primaryClip.clip.id.slice(0, 55)}-c${crypto.randomUUID().slice(0, 4)}`, startMs: primaryClip.clip.startMs + primaryClip.clip.durationMs } as NleClip;
    mutate(withTracks(project, tracks => tracks.map(track => track.id === primary.trackId ? { ...track, clips: [...track.clips, copy] } : track)));
    setSelection([{ trackId: primary.trackId, clipId: copy.id }]);
  };
  const patchClip = (patch: Partial<NleClip>, history = true) => {
    if (!primary || !primaryClip || primaryClip.track.locked) return;
    const next = withTracks(projectRef.current, tracks => tracks.map(track => track.id !== primary.trackId ? track : { ...track, clips: track.clips.map(clip => clip.id === primary.clipId ? { ...clip, ...patch } as NleClip : clip) }));
    if (history) mutate(next); else local(next);
  };
  const toggleTrack = (trackId: string, field: "muted" | "locked") => {
    mutate(withTracks(project, tracks => tracks.map(track => track.id === trackId ? { ...track, [field]: !track[field] } : track)));
  };

  const snapValue = (snapshot: NleProject, valueMs: number, excludedClipIds: readonly string[]): number => {
    if (!snap) { setSnapGuide(null); return valueMs; }
    const point = nleSnap(valueMs, nleSnapPoints(snapshot, { playheadMs: playhead, excludeClipIds: excludedClipIds }), SNAP_PX / pxPerMs);
    setSnapGuide(point);
    return point ?? valueMs;
  };
  const onPointerDown = (event: React.PointerEvent, trackId: string, clip: NleClip, edge?: "start" | "end") => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const track = project.tracks.find(item => item.id === trackId);
    if (track?.locked) { setError("轨道已锁定；先解锁再编辑。"); return; }
    const target = { trackId, clipId: clip.id };
    const isSelected = selection.some(item => item.trackId === trackId && item.clipId === clip.id);
    const selected = event.shiftKey
      ? isSelected ? selection.filter(item => !(item.trackId === trackId && item.clipId === clip.id)) : [...selection, target]
      : isSelected ? selection : [target];
    setSelection(selected);
    drag.current = { startX: event.clientX, snapshot: project, primary: target, selected, edge };
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Stale/synthetic pointer ids throw; drag still tracks while the button stays down. */ }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current; if (!current) return;
    const delta = (event.clientX - current.startX) / pxPerMs;
    const snapshot = current.snapshot;
    const excluded = current.selected.map(item => item.clipId);
    const track = snapshot.tracks.find(item => item.id === current.primary.trackId);
    const clip = track?.clips.find(item => item.id === current.primary.clipId);
    if (!clip) return;
    if (current.edge) {
      const raw = current.edge === "start" ? clip.startMs + delta : clip.startMs + clip.durationMs + delta;
      const snapped = snapValue(snapshot, raw, excluded);
      const applied = snapped - (current.edge === "start" ? clip.startMs : clip.startMs + clip.durationMs);
      const next = nleTrimClip(snapshot, current.primary.trackId, current.primary.clipId, current.edge, applied);
      projectRef.current = next;
      setProject(next);
      return;
    }
    const rawStart = Math.max(0, clip.startMs + delta);
    const snappedStart = Math.max(0, snapValue(snapshot, rawStart, excluded));
    const shift = snappedStart - clip.startMs;
    let next = snapshot;
    for (const item of current.selected.length ? current.selected : [current.primary]) {
      const target = next.tracks.find(candidate => candidate.id === item.trackId)?.clips.find(candidate => candidate.id === item.clipId);
      if (!target) continue;
      next = nleMoveClip(next, item.trackId, item.clipId, Math.max(0, target.startMs + shift));
    }
    projectRef.current = next;
    setProject(next);
  };
  const endDrag = () => {
    const current = drag.current; drag.current = null; setSnapGuide(null);
    if (!current) return;
    const latest = projectRef.current;
    if (latest !== current.snapshot) {
      undoStack.current.push(current.snapshot);
      if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
      redoStack.current = [];
    }
    setHistoryTick(value => value + 1);
  };
  const exportProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${project.id}.nle.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };
  const render = async () => {
    if (rendering) return;
    setRendering(true); setError(""); setStatus("正在渲染多轨成片…"); setResult(null);
    try {
      const response = await fetch("/api/nle/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }), signal: AbortSignal.timeout(300_000) });
      const data = await response.json();
      if (!response.ok || typeof data?.url !== "string") throw new Error(data?.error ?? "NLE 渲染失败");
      setResult({ url: data.url, file: data.file }); setStatus(`成片已生成 · ${Math.round(Number(data.bytes) / 1024)} KB`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "NLE 渲染失败"); setStatus(""); }
    finally { setRendering(false); }
  };
  const exportTimeline = async (format: "fcpxml" | "edl") => {
    if (exporting) return;
    setExporting(format); setError(""); setTimelineResult(null);
    try {
      const response = await fetch("/api/nle/timeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, format }), signal: AbortSignal.timeout(60_000) });
      const data = await response.json();
      if (!response.ok || typeof data?.url !== "string") throw new Error(data?.error ?? "剪辑表导出失败");
      setTimelineResult({ url: data.url, file: data.file, clips: data.clips, textClips: data.textClips, warning: data.warning });
      setStatus(`已导出 ${format.toUpperCase()} · ${data.clips} 个事件`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "剪辑表导出失败"); }
    finally { setExporting(null); }
  };

  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const bandStart = useRef<{ x: number; y: number } | null>(null);
  const onLanesDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    bandStart.current = { x: event.clientX, y: event.clientY };
    setBand({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY });
  };
  const onLanesMove = (event: React.PointerEvent) => {
    if (!bandStart.current) return;
    setBand(current => current ? { ...current, x1: event.clientX, y1: event.clientY } : current);
  };
  const onLanesUp = () => {
    const rect = band;
    bandStart.current = null;
    setBand(null);
    if (!rect) return;
    // Below ~6px in both axes it was a click: keep the existing seek behaviour.
    if (Math.abs(rect.x1 - rect.x0) < 6 || Math.abs(rect.y1 - rect.y0) < 6) return;
    const container = lanesRef.current?.getBoundingClientRect();
    if (!container) return;
    const fromMs = (Math.min(rect.x0, rect.x1) - container.left) / pxPerMs;
    const toMs = (Math.max(rect.x0, rect.x1) - container.left) / pxPerMs;
    const top = Math.min(rect.y0, rect.y1) - container.top;
    const bottom = Math.max(rect.y0, rect.y1) - container.top;
    const picked: Selection[] = [];
    project.tracks.forEach((track, index) => {
      const rowTop = index * TRACK_ROW_H, rowBottom = rowTop + TRACK_ROW_H;
      if (rowBottom < top || rowTop > bottom) return;
      for (const clip of track.clips) {
        if (clip.startMs < toMs && clip.startMs + clip.durationMs > fromMs) picked.push({ trackId: track.id, clipId: clip.id });
      }
    });
    setSelection(picked);
  };
  const keys = useRef({ undo, redo, removeSelected, split, seek, playhead, duration, fps: project.fps });
  keys.current = { undo, redo, removeSelected, split, seek, playhead, duration, fps: project.fps };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable=true]")) return;
      const current = keys.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? current.redo() : current.undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); current.redo(); return; }
      if (event.key === " ") { event.preventDefault(); setPlaying(value => !value); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); current.removeSelected(); return; }
      if (event.key.toLowerCase() === "s" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); current.split(); return; }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const step = event.shiftKey ? 1000 : Math.round(1000 / current.fps); current.seek(current.playhead + (event.key === "ArrowRight" ? step : -step)); return; }
      if (event.key === "Home") { event.preventDefault(); current.seek(0); }
      if (event.key === "End") { event.preventDefault(); current.seek(current.duration); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const seconds = Math.ceil(duration / 1000) + 2, width = Math.max(720, seconds * 1000 * pxPerMs);
  const fit = () => setPxPerMs(Math.max(0.01, Math.min(0.3, (Math.max(360, window.innerWidth - 460)) / Math.max(1000, duration + 2000))));
  const tickMs = pxPerMs * 1000 >= 70 ? 1000 : pxPerMs * 1000 >= 35 ? 2000 : 5000;
  const ticks = Math.ceil((duration + 2000) / tickMs);

  return <section aria-label="剪辑台" tabIndex={-1} data-history={historyTick} style={{ height: "100dvh", minHeight: 0, overflow: "hidden", background: "#08090b", color: "#e4e4e7", display: "grid", gridTemplateRows: "auto minmax(0,1fr) 224px" }}>
    <header style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", borderBottom: "1px solid #26262b" }}>
      <strong>剪辑台</strong>
      <input aria-label="剪辑标题" value={project.title} onChange={event => mutate(parseNleProject({ ...project, title: event.target.value || "未命名剪辑" }), false)} style={{ ...text, width: 170 }} />
      <span style={{ color: "#8b8b95", fontSize: 11 }}>{project.width}×{project.height} · {project.fps}fps · {(duration / 1000).toFixed(1)}s · {selection.length > 1 ? `已选 ${selection.length}` : ""}</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" aria-label="撤销" style={{ ...button, opacity: undoStack.current.length ? 1 : 0.45 }} disabled={!undoStack.current.length} onClick={undo} title="Ctrl+Z">撤销</button>
        <button type="button" aria-label="重做" style={{ ...button, opacity: redoStack.current.length ? 1 : 0.45 }} disabled={!redoStack.current.length} onClick={redo} title="Ctrl+Shift+Z">重做</button>
        <button type="button" style={button} onClick={() => importRef.current?.click()}>导入 NLE</button>
        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { mutate(parseNleProject(JSON.parse(await file.text())), false); setSelection([]); setStatus("已导入 NLE 工程"); } catch { setError("NLE 工程无法解析"); } finally { event.target.value = ""; } }} />
        <button type="button" style={button} onClick={exportProject}>导出 NLE JSON</button>
        <button type="button" style={button} disabled={exporting !== null} onClick={() => void exportTimeline("fcpxml")}>{exporting === "fcpxml" ? "导出中…" : "FCPXML"}</button>
        <button type="button" style={button} disabled={exporting !== null} onClick={() => void exportTimeline("edl")}>{exporting === "edl" ? "导出中…" : "EDL"}</button>
        <button type="button" style={{ ...button, background: "#f4f4f5", color: "#09090b" }} disabled={rendering} onClick={() => void render()}>{rendering ? "渲染中…" : "渲染 MP4"}</button>
        {onClose && <button type="button" style={button} onClick={onClose}>返回首页</button>}
      </div>
    </header>

    <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr) 290px", gap: 10, padding: 10, minHeight: 0, overflow: "hidden" }}>
      <aside aria-label="素材库" style={{ display: "grid", gap: 6, alignContent: "start", maxHeight: "100%", minHeight: 0, overflow: "auto", padding: 8, border: "1px solid #26262b", borderRadius: 10, background: "#0d0d10" }}>
        <strong style={{ fontSize: 12 }}>素材库</strong>
        <button type="button" style={button} onClick={addText}>+ 文字</button>
        {assets.map(asset => {
          const kind = kindOf(asset.name)!;
          return <div key={asset.name} style={{ display: "grid", gap: 4, padding: 6, border: "1px solid #26262b", borderRadius: 8 }}>
            {kind === "image" ? <img src={asset.url} alt="" loading="lazy" style={{ width: "100%", height: 54, objectFit: "cover", borderRadius: 5 }} /> : kind === "video" ? <video src={asset.url} muted preload="metadata" style={{ width: "100%", height: 54, objectFit: "cover", borderRadius: 5 }} /> : <div style={{ height: 32, display: "grid", placeItems: "center", background: "#131318", borderRadius: 5, fontSize: 11 }}>音频</div>}
            <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#a1a1aa", fontSize: 10 }}>{asset.name}</small>
            <div style={{ display: "flex", gap: 4 }}>
              <button type="button" style={{ ...button, padding: "3px 6px", fontSize: 10 }} onClick={() => addAsset(asset)}>{kindOf(asset.name) === "audio" ? "加入音频轨" : "加入画面轨"}</button>
            </div>
          </div>;
        })}
        {!assets.length && <small style={{ color: "#8b8b95", fontSize: 11, lineHeight: 1.6 }}>素材库为空。先在首页生成或导入图片/视频/音频，再回到剪辑台。</small>}
      </aside>

      <div style={{ display: "grid", gap: 8, minWidth: 0, minHeight: 0 }}>
        <div style={{ border: "1px solid #26262b", borderRadius: 10, overflow: "hidden", background: "#000" }}>
          <div style={{ maxHeight: "100%", minHeight: 0, display: "grid", justifyItems: "stretch", alignContent: "center" }}>
            <NlePreview project={project} mediaAssetBase="/api/media/assets/" tMs={playhead} playing={playing} onTimeUpdate={setPlayhead} onEnded={() => setPlaying(false)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", color: "#8b8b95", fontSize: 11, flexWrap: "wrap" }}>
          <span>播放头 {(playhead / 1000).toFixed(2)}s</span>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>缩放<input aria-label="时间线缩放" type="range" min="0.01" max="0.3" step="0.005" value={pxPerMs} onChange={event => setPxPerMs(Number(event.target.value))} /></label>
          <button type="button" style={{ ...button, padding: "4px 8px" }} onClick={fit}>适配</button>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input aria-label="吸附" type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />吸附</label>
          <button type="button" style={button} disabled={!primaryClip} onClick={split}>在播放头切分</button>
          <button type="button" style={button} disabled={!primaryClip} onClick={duplicate}>复制片段</button>
          <button type="button" style={button} disabled={!selection.length} onClick={removeSelected}>删除片段</button>
          {status && <span role="status">{status}</span>}
          {result && <a href={result.url} download={result.file} style={{ color: "#d4d4d8" }}>下载 MP4</a>}
          {timelineResult && <a href={timelineResult.url} download={timelineResult.file} style={{ color: "#d4d4d8" }}>下载 {timelineResult.file.endsWith(".fcpxml") ? "FCPXML" : "EDL"}（{timelineResult.clips} 事件）</a>}
        </div>
        {timelineResult?.warning && <small role="status" style={{ color: "#fbbf24", fontSize: 11 }}>{timelineResult.warning}</small>}
      </div>

      <aside aria-label="片段属性" style={{ display: "grid", gap: 8, alignContent: "start", maxHeight: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: 10, border: "1px solid #26262b", borderRadius: 10, background: "#0d0d10", minWidth: 0, boxSizing: "border-box" }}>
        <strong style={{ fontSize: 12 }}>片段属性</strong>
        {!primaryClip ? <small style={{ color: "#8b8b95" }}>选一个片段开始调整。Shift+点击可多选。</small> : <>
          <small style={{ color: "#8b8b95" }}>{primaryClip.track.name} · {primaryClip.clip.kind} · {primaryClip.clip.id}{selection.length > 1 ? ` · +${selection.length - 1}` : ""}</small>
          <label style={label}>起点 ms<input aria-label="起点 ms" type="number" style={text} value={primaryClip.clip.startMs} onFocus={beginField} onBlur={endField} onChange={event => mutate(nleMoveClip(projectRef.current, primary!.trackId, primary!.clipId, Number(event.target.value)), false)} /></label>
          <label style={label}>时长 ms<input aria-label="时长 ms" type="number" min={100} style={text} value={primaryClip.clip.durationMs} onFocus={beginField} onBlur={endField} onChange={event => mutate(nleTrimClip(projectRef.current, primary!.trackId, primary!.clipId, "end", Number(event.target.value) - primaryClip.clip.durationMs), false)} /></label>
          <label style={label}>速度 {(primaryClip.clip.speed ?? 1).toFixed(2)}×<input type="range" min="0.25" max="4" step="0.05" value={primaryClip.clip.speed ?? 1} onChange={event => patchClip({ speed: Number(event.target.value) })} /></label>
          <label style={label}>不透明度 {Math.round((primaryClip.clip.opacity ?? 1) * 100)}%<input type="range" min="0" max="1" step="0.01" value={primaryClip.clip.opacity ?? 1} onChange={event => patchClip({ opacity: Number(event.target.value) })} /></label>
          {(primaryClip.clip.kind === "audio" || primaryClip.clip.kind === "video") && <label style={label}>音量 {Math.round((primaryClip.clip.volume ?? 1) * 100)}%<input type="range" min="0" max="1" step="0.01" value={primaryClip.clip.volume ?? 1} onChange={event => patchClip({ volume: Number(event.target.value) })} /></label>}
          {primaryClip.clip.kind === "text" && <>
            <label style={label}>文字<textarea rows={3} style={text} value={primaryClip.clip.text} onChange={event => patchClip({ text: event.target.value || " " })} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <label style={label}>字号<input type="number" min={12} max={240} style={text} value={primaryClip.clip.fontSize ?? 72} onChange={event => patchClip({ fontSize: Number(event.target.value) })} /></label>
              <label style={label}>颜色<input type="color" value={primaryClip.clip.color ?? "#f4f4f5"} onChange={event => patchClip({ color: event.target.value })} style={{ inlineSize: "100%", blockSize: 26, padding: 0, border: "1px solid #2b2b31", borderRadius: 6, background: "#151518", cursor: "pointer" }} /></label>
            </div>
            <label style={label}>对齐<select style={text} value={primaryClip.clip.align ?? "center"} onChange={event => patchClip({ align: event.target.value as "left" | "center" | "right" })}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label>
          </>}
          {primaryClip.clip.kind !== "audio" && <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {(["x", "y", "scale", "rotate"] as const).map(key => <label key={key} style={label}>{key}<input type="number" step={key === "scale" ? 0.05 : key === "rotate" ? 1 : 0.01} style={text} value={primaryClip.clip.transform?.[key] ?? (key === "scale" ? 1 : 0)} onChange={event => patchClip({ transform: { ...primaryClip.clip.transform, [key]: Number(event.target.value) } })} /></label>)}
            </div>
            <label style={label}>入场转场<select aria-label="入场转场" style={text} value={primaryClip.clip.transitionIn?.type ?? ""} onChange={event => patchClip({ transitionIn: event.target.value ? { type: event.target.value as ClipTransitionType, durationMs: primaryClip.clip.transitionIn?.durationMs ?? DEFAULT_FADE_MS } : undefined })}>{TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label style={label}>出场转场<select aria-label="出场转场" style={text} value={primaryClip.clip.transitionOut?.type ?? ""} onChange={event => patchClip({ transitionOut: event.target.value ? { type: event.target.value as ClipTransitionType, durationMs: primaryClip.clip.transitionOut?.durationMs ?? DEFAULT_FADE_MS } : undefined })}>{TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            {(primaryClip.clip.transitionIn || primaryClip.clip.transitionOut) && <label style={label}>转场时长 ms<input aria-label="转场时长 ms" type="number" min={100} max={5000} step={50} style={text} value={primaryClip.clip.transitionIn?.durationMs ?? primaryClip.clip.transitionOut?.durationMs ?? DEFAULT_FADE_MS} onChange={event => { const durationMs = Math.min(5000, Math.max(100, Number(event.target.value))); patchClip({ ...(primaryClip.clip.transitionIn ? { transitionIn: { ...primaryClip.clip.transitionIn, durationMs } } : {}), ...(primaryClip.clip.transitionOut ? { transitionOut: { ...primaryClip.clip.transitionOut, durationMs } } : {}) }); }} /></label>}
            <small style={{ color: "#6f6f78", fontSize: 10, lineHeight: 1.5 }}>转场在当前片段内部完成，不需要相邻片段重叠。预览与导出逐帧一致。</small>
            <div style={{ borderTop: "1px solid #26262b", paddingTop: 8, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <strong style={{ fontSize: 11, color: "#a1a1aa" }}>关键帧 {primaryClip.clip.keyframes?.length ?? 0}</strong>
                <div style={{ display: "flex", gap: 4 }}>
                  <button type="button" aria-label="在播放头记录关键帧" style={{ ...button, padding: "3px 7px", fontSize: 10 }} onClick={() => {
                    const local = Math.max(0, Math.min(primaryClip.clip.durationMs, Math.round(playhead - primaryClip.clip.startMs)));
                    const existing = [...(primaryClip.clip.keyframes ?? [])].filter(frame => frame.ms !== local);
                    const next = [...existing, { ms: local, x: primaryClip.clip.transform?.x ?? 0, y: primaryClip.clip.transform?.y ?? 0, scale: primaryClip.clip.transform?.scale ?? 1, rotate: primaryClip.clip.transform?.rotate ?? 0, opacity: primaryClip.clip.opacity ?? 1 }].sort((a, b) => a.ms - b.ms);
                    patchClip({ keyframes: next.slice(0, 32) });
                  }}>＋ 记录</button>
                  <button type="button" aria-label="清除关键帧" style={{ ...button, padding: "3px 7px", fontSize: 10 }} disabled={!primaryClip.clip.keyframes?.length} onClick={() => patchClip({ keyframes: undefined })}>清除</button>
                </div>
              </div>
              {(primaryClip.clip.keyframes ?? []).map((frame, index) => <div key={frame.ms} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 26px", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#8b8b95" }}>{frame.ms}ms · {Math.round((frame.opacity ?? 1) * 100)}% · {Number(frame.scale ?? 1).toFixed(2)}×</span>
                <button type="button" style={{ ...button, padding: "2px 6px", fontSize: 10 }} onClick={() => seek(primaryClip.clip.startMs + frame.ms)}>定位</button>
                <button type="button" aria-label={`删除关键帧 ${frame.ms}`} style={{ ...button, padding: "2px 4px", fontSize: 10 }} onClick={() => patchClip({ keyframes: primaryClip.clip.keyframes!.filter((_, i) => i !== index) })}>×</button>
              </div>)}
              <small style={{ color: "#6f6f78", fontSize: 10, lineHeight: 1.5 }}>记录时取当前位置/缩放/不透明度；两端之间线性或缓动插值。</small>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <label style={label}>混合<select aria-label="混合模式" style={text} value={primaryClip.clip.blend ?? "normal"} onChange={event => patchClip({ blend: event.target.value === "normal" ? undefined : event.target.value as NonNullable<NleClip["blend"]> })}>{["normal", "screen", "multiply", "overlay", "darken", "lighten", "soft-light"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
              <label style={label}>蒙版<select aria-label="蒙版形状" style={text} value={primaryClip.clip.mask?.shape ?? ""} onChange={event => patchClip({ mask: event.target.value ? { shape: event.target.value as "circle" | "rect", feather: primaryClip.clip.mask?.feather ?? 0.08, inset: primaryClip.clip.mask?.inset ?? 0.05 } : undefined })}><option value="">无</option><option value="circle">圆形</option><option value="rect">矩形</option></select></label>
            </div>
            {primaryClip.clip.mask && <>
              <label style={label}>羽化 {Math.round((primaryClip.clip.mask.feather ?? 0) * 100)}%<input aria-label="蒙版羽化" type="range" min="0" max="0.5" step="0.01" value={primaryClip.clip.mask.feather ?? 0} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, feather: Number(event.target.value) } })} /></label>
              {primaryClip.clip.mask.shape === "rect" && <label style={label}>内缩 {Math.round((primaryClip.clip.mask.inset ?? 0) * 100)}%<input aria-label="蒙版内缩" type="range" min="0" max="0.45" step="0.01" value={primaryClip.clip.mask.inset ?? 0} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, inset: Number(event.target.value) } })} /></label>}
              <label style={{ ...label, display: "flex", alignItems: "center", gap: 6 }}><input aria-label="反转蒙版" type="checkbox" checked={Boolean(primaryClip.clip.mask.invert)} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, invert: event.target.checked || undefined } })} />反转</label>
            </>}
          </>}
        </>}
        {error && <p role="alert" style={{ margin: 0, color: "#fca5a5", fontSize: 11 }}>{error}</p>}
      </aside>
    </div>

    <div aria-label="多轨时间线" style={{ borderTop: "1px solid #26262b", background: "#0d0d10", padding: 8, overflow: "auto" }}>
      <div style={{ position: "relative", width: width + 140, minWidth: "100%" }}>
        <div aria-label="时间标尺" style={{ marginLeft: 140, height: 20, position: "relative", borderBottom: "1px solid #26262b", cursor: "crosshair" }}
          onPointerDown={event => { if (event.button !== 0) return; ruler.current = true; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional */ } }}
          onPointerMove={event => { if (!ruler.current) return; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); }}
          onPointerUp={() => { ruler.current = false; }} onPointerCancel={() => { ruler.current = false; }}>
          {Array.from({ length: ticks }, (_, index) => <span key={index} style={{ position: "absolute", left: index * tickMs * pxPerMs, fontSize: 9, color: "#6b6b76" }}>{(index * tickMs / 1000).toFixed(tickMs >= 1000 ? 0 : 1)}s</span>)}
        </div>
        <div style={{ display: "flex", gap: 6, padding: "2px 0 6px 140px", alignItems: "center", flexWrap: "wrap" }}>
          {TRACK_KINDS.map(item => <button key={item.kind} type="button" style={{ ...button, padding: "3px 8px", fontSize: 10 }} onClick={() => addTrack(item.kind)}>{item.label}</button>)}
          <small style={{ color: "#6b6b76", fontSize: 10 }}>空白处拖框可框选（最多 8 条轨道）</small>
        </div>
        <div ref={lanesRef} style={{ position: "relative" }} onPointerDown={onLanesDown} onPointerMove={onLanesMove} onPointerUp={onLanesUp}>
        {project.tracks.map(track => <div key={track.id} style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", alignItems: "center", height: TRACK_ROW_H, borderBottom: "1px solid #1c1c21", opacity: track.muted ? 0.55 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, paddingRight: 4 }}>
            <span title={track.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: track.kind === "audio" ? "#5eead4" : "#a1a1aa", fontSize: 11 }}>{track.name}</span>
            <button type="button" aria-label={`${track.name} 静音`} aria-pressed={Boolean(track.muted)} title={track.muted ? "取消静音" : "静音"} style={{ width: 18, height: 18, border: "1px solid #2b2b31", borderRadius: 4, background: track.muted ? "#3f3f46" : "transparent", color: track.muted ? "#f4f4f5" : "#6b6b76", cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0 }} onClick={() => toggleTrack(track.id, "muted")}>M</button>
            <button type="button" aria-label={`${track.name} 锁定`} aria-pressed={Boolean(track.locked)} title={track.locked ? "解锁轨道" : "锁定轨道"} style={{ width: 18, height: 18, border: "1px solid #2b2b31", borderRadius: 4, background: track.locked ? "#3f3f46" : "transparent", color: track.locked ? "#fbbf24" : "#6b6b76", cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0 }} onClick={() => toggleTrack(track.id, "locked")}>L</button>
            <button type="button" aria-label={`删除 ${track.name}`} title="删除轨道（Ctrl+Z 可撤销）" style={{ width: 18, height: 18, border: "1px solid #2b2b31", borderRadius: 4, background: "transparent", color: "#6b6b76", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }} onClick={() => removeTrack(track.id)}>×</button>
          </div>
          <div style={{ position: "relative", height: 38, background: "#111116", borderRadius: 6 }} onPointerDown={event => { if (event.button !== 0) return; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); }}>
            {track.clips.map(clip => {
              const selected = selectedIds.has(clip.id);
              const incoming = nleTransitionProgress(clip, 0, "in") !== null;
              return <div key={clip.id} role="button" tabIndex={0} aria-label={`${track.name} ${clip.id}`} aria-pressed={selected} style={{ ...clipStyle(clip), left: clip.startMs * pxPerMs, width: Math.max(12, clip.durationMs * pxPerMs), outline: selected ? "2px solid #f4f4f5" : undefined }}
                onPointerDown={event => onPointerDown(event, track.id, clip)} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => seek(clip.startMs)}>
                {clip.kind === "audio" && <ClipWaveform src={audioAssets.get(clip.id) ?? null} />}
                <span style={{ position: "absolute", inset: "4px 8px", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.kind === "text" ? clip.text : clip.kind === "audio" ? "音频" : clip.kind}{incoming ? " ▸" : ""}{clip.speed && clip.speed !== 1 ? ` ${clip.speed}×` : ""}</span>
                <span aria-label="左侧修剪" onPointerDown={event => onPointerDown(event, track.id, clip, "start")} onPointerMove={onPointerMove} onPointerUp={endDrag} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "#ffffff44" }} />
                <span aria-label="右侧修剪" onPointerDown={event => onPointerDown(event, track.id, clip, "end")} onPointerMove={onPointerMove} onPointerUp={endDrag} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "#ffffff44" }} />
              </div>;
            })}
          </div>
        </div>)}
        </div>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 140 + playhead * pxPerMs, width: 1, background: "#f4f4f5", pointerEvents: "none", zIndex: 3 }} />
        {snapGuide !== null && <div aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: 140 + snapGuide * pxPerMs, width: 1, background: "#fbbf24", pointerEvents: "none", zIndex: 3 }} />}
      </div>
    </div>
  </section>;
}
