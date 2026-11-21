import { TimelineDock } from "./TimelineDock";
import { t } from "./ui/i18n";
import { NleRenderOptions } from "./NleRenderOptions";
import { executeNleRender, type NleRenderResult } from "./nle-render-client";
import { useNleSharedDocument, type SharedNleBinding } from "./useNleSharedDocument";
import { isLocalAgentAvailable } from "./local-agent-client";
import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { ProjectArchivePanel } from "./ProjectArchivePanel";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DeliveryPanel } from "./DeliveryPanel";
import { ContainerPlanPreview } from "./ContainerPlanPreview";
import "./nle-theme.css";
import { NlePreview } from "./NlePreview";
import { NleLibrary } from "./NleLibrary";
import { NleProposal } from "./NleProposal";
import { NleMotionEditor } from "./NleMotionEditor";
import { LocalAgentChat } from "./LocalAgentChat";
import { addMotionKeyframe } from "./nle-motion";
import { NleProjectSettings } from "./NleProjectSettings";
import { NleClipThumbnail } from "./NleClipThumbnail";
import { NleBeatCalibration, parseBeatCalibration, type BeatCalibration } from "./NleBeatCalibration";
import { beatSnapCandidates, onsetSnapCandidates, type ManualBeatGrid } from "./nle-beat-grid";
import { clampLinkedShift, mainTrackOf, moveLinkedClips, removeMainWithLinked } from "./nle-linked";
import { captionCuesForClip } from "./nle-captions";
import { parseEditorProject, downloadJson } from "./editor-model";
import { createNleSession, type NleSession } from "./nle-session";
import { nleRecordKey, parseNleRecord, parseNleBridge, readNleLibrary, serializeNleRecord, type NleBridge } from "./nle-project-library";
import { readNlePair, recoverNleSave, saveNlePair, type NleStoredPair } from "./nle-storage";
import type { SessionState } from "@glintai/session";
import { readSavedProjects, saveProject } from "./project-history";
import type { Transcript } from "@glintai/composer/asr";
import {
  applyNleToSceneScript, nleAddTrack, nleDurationMs, nleMagnetizeTrack, nleMoveClip, nleRemoveClip, nleRemoveTrack, nleRollEdit, nleSnap, nleSnapPoints, nleSplitClip, nleTrimClip, nleTransitionProgress,
  parseNleProject, sceneScriptToNle, type NleClip, type NleProject, type NleTrack, type SceneNleLink,
} from "@glintai/scenescript";

const STORAGE = "glint.nle.project.v2";
const SESSION_STORAGE = "glint.nle.session.v1";
const BRIDGE_STORAGE = "glint.nle.bridge.v1";
const DEFAULT_FADE_MS = 500;
const SNAP_PX = 8;
type EstimatedBeats = { trackId: string; clipId: string; signature: string; beatsMs: number[]; bpm: number; sourceSha256: string; calibration: BeatCalibration | null };
function audioBeatSignature(trackId: string, clip: Extract<NleClip, { kind: "audio" }>) {
  return JSON.stringify([trackId, clip.id, clip.src, clip.startMs, clip.durationMs, clip.trimStartMs ?? 0, clip.speed ?? 1, clip.speedCurve ?? null, clip.speedRamp ?? null]);
}
/** Only for out-of-scope children that take a style prop (NleBeatCalibration); everything else uses system classes. */
const plainButton: CSSProperties = { border: 0, borderRadius: 0, background: "transparent", color: "inherit", padding: 0, font: "inherit", fontSize: 11, cursor: "pointer", textAlign: "left" };
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
    tracks: DEFAULT_TRACKS.map(track => ({ ...track, clips: [] })),
  });
}

function kindOf(name: string): "image" | "video" | "audio" | null {
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "image";
  if (/\.mp4$/i.test(name)) return "video";
  if (/\.(mp3|wav)$/i.test(name)) return "audio";
  return null;
}

/** mm:ss.f timecode for the transport bar. */
function timecodeOf(ms: number): string {
  const total = Math.max(0, ms), seconds = Math.floor(total / 1000), tenth = Math.floor((total % 1000) / 100);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${tenth}`;
}

/**
 * DCC-style scrub label: drag the label text horizontally to sweep the value
 * (one step per 3 px, Shift = ×10). Commits on pointer-up only.
 */
function ScrubLabel({ value, step, min, max, onCommit, children }: { value: number; step: number; min?: number; max?: number; onCommit(next: number): void; children: React.ReactNode }) {
  const session = useRef<{ startX: number; startValue: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  return <label className="nle-scrub"
    onPointerDown={event => {
      if (event.button !== 0 || !event.currentTarget.hasPointerCapture) return;
      session.current = { startX: event.clientX, startValue: value };
      setPreview(value);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
    }}
    onPointerMove={event => {
      if (!session.current) return;
      const delta = Math.round((event.clientX - session.current.startX) / 3) * step * (event.shiftKey ? 10 : 1);
      let next = session.current.startValue + delta;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      setPreview(next);
    }}
    onPointerUp={() => { if (session.current && preview !== null && preview !== value) onCommit(preview); session.current = null; setPreview(null); }}
    onPointerCancel={() => { session.current = null; setPreview(null); }}
    title="拖动调整（Shift 加速）">{children} <span className="nle-scrub-value g-num">{preview !== null ? `→ ${preview}` : value}</span></label>;
}

const SHORTCUTS: Array<[string, string]> = [
  ["空格", "播放 / 暂停"],
  ["← / →", "后退 / 前进一帧（Shift = 1 秒）"],
  ["Home / End", "跳到开头 / 结尾"],
  ["S", "在播放头切分选中片段"],
  ["B", "剃刀：在播放头切分所有轨道"],
  ["K", "在播放头记录关键帧（选中片段）"],
  ["Alt+拖动片段右缘", "Roll：与右邻片段共享边界，总时长不变"],
  ["Delete / Backspace", "删除选中片段"],
  ["Ctrl+Z / Ctrl+Shift+Z", "撤销 / 重做"],
  ["双击片段", "播放头跳到片段开头"],
  ["Shift+点击", "加选片段；拖空白处框选"],
  ["?", "打开 / 关闭本面板"],
];

function withTracks(project: NleProject, update: (tracks: NleTrack[]) => NleTrack[]): NleProject {
  return parseNleProject({ ...project, tracks: update(project.tracks) });
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
  return <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" className="nle-clip-wave">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
  </svg>;
}

/**
 * Desktop multi-track editor. Preview and MP4 export run the same Remotion
 * composition, so what the timeline shows is what the renderer encodes.
 * v2 adds waveforms, snapping, undo/redo, multi-select, edge transitions and a
 * timeline export that does not require re-rendering.
 */
/** Drop the old canned prompt clip: it was a UI hint, but it would render into exports. */
function loadStoredProject(): {project:NleProject;session:NleSession;stored:NleStoredPair;error:string;record?:string|null;bridge?:NleBridge|null} {
  let stored:NleStoredPair={project:null,session:null}, project=defaultProject();
  try {
    recoverNleSave(localStorage);stored=readNlePair(localStorage);
    const raw=stored.project ?? localStorage.getItem("glint.nle.project.v1");
    if(raw!==null)project=parseNleProject(JSON.parse(raw));
    let session=createNleSession(project);
    if(stored.session!==null){
      const state=JSON.parse(stored.session) as SessionState<NleProject>;
      if(state?.projectId!==project.id || JSON.stringify(parseNleProject(state.document))!==JSON.stringify(project))throw new Error("剪辑工程与撤销记录不一致；原始记录已保留，请先备份。");
      session=createNleSession(project,state);
    }
    const record=localStorage.getItem(nleRecordKey(project.id));
    let bridge:NleBridge|null=null;
    if(record!==null){
      const saved=parseNleRecord(record,project.id);
      if(saved.pair.project!==stored.project||saved.pair.session!==stored.session)throw new Error("当前剪辑与工程库记录不一致，请先备份后核对。");
      bridge=saved.bridge;
    }else{
      const rawBridge=localStorage.getItem(BRIDGE_STORAGE);
      if(rawBridge!==null){const value=JSON.parse(rawBridge);if(value?.sourceId===project.id || readSavedProjects().some(entry=>entry.id===value?.sourceId&&entry.project?.id===project.id))bridge=parseNleBridge({...value,projectId:project.id},project.id);}
    }
    const tracks=project.tracks.map(track=>({...track,clips:track.clips.filter(clip=>!(clip.kind==="text"&&clip.id==="title"&&clip.text==="双击时间线开始剪辑"))}));
    if(tracks.some((track,index)=>track.clips.length!==project.tracks[index]!.clips.length)){project=parseNleProject({...project,tracks});session.amendTo(project);}
    return {project,session,stored,error:"",record,bridge};
  }catch(cause){return {project,session:createNleSession(project),stored,error:cause instanceof Error?`剪辑自动保存已停用：${cause.message}`:"剪辑记录无法读取；原记录已保留，请先备份。"};}
}

export function NleEditor({ onClose, active = true, openRequest, shared }: { onClose?(): void; active?: boolean; openRequest?:{sourceId:string;nonce:number}; shared?:SharedNleBinding }) {
  const activeRef = useRef(active); activeRef.current = active;
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  const sharedDocument = useNleSharedDocument(shared, next => { projectRef.current = next; setProject(next); });
  const [loaded]=useState(() => shared ? { project:defaultProject(),session:sharedDocument.session,stored:{project:null,session:null} as NleStoredPair,error:"",bridge:null,record:null } : loadStoredProject());
  const [project, setProject] = useState<NleProject>(loaded.project);
  const session = shared ? sharedDocument.session : loaded.session;
  const storedPair=useRef(loaded.stored);
  const recordBytes=useRef(new Map<string,string|null>([[loaded.project.id,loaded.record??null]]));
  const [library,setLibrary]=useState<Array<{id:string;title:string;raw:string}>>([]);
  const [libraryOpen,setLibraryOpen]=useState(false);
  const [archiveOpen,setArchiveOpen]=useState(false);
  const projectEpoch=useRef(0);
  const projectRequests=useRef(new Set<AbortController>());
  const cancelProjectRequests=()=>{for(const request of projectRequests.current)request.abort();projectRequests.current.clear();};
  useEffect(()=>()=>{projectEpoch.current++;cancelProjectRequests();},[]);
  const [libraryError,setLibraryError]=useState("");
  const [storageError,setStorageError]=useState(loaded.error);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selection, setSelection] = useState<Selection[]>([]);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const [playhead, setPlayhead] = useState(0);
  const [pxPerMs, setPxPerMs] = useState(0.08);
  const [snap, setSnap] = useState(true);
  const [beatEnabled, setBeatEnabled] = useState(false);
  const [beatBpm, setBeatBpm] = useState("120"), [beatOffset, setBeatOffset] = useState("0"), [beatDivision, setBeatDivision] = useState<ManualBeatGrid["subdivisions"]>(1);
  const [beatMode, setBeatMode] = useState<"manual" | "audio">("manual"), [estimatedBeats, setEstimatedBeats] = useState<EstimatedBeats | null>(null);
  const [beatAnalyzing, setBeatAnalyzing] = useState(false), [beatFeedback, setBeatFeedback] = useState("");
  const beatRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { beatRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!beatRequest.current) return;
    beatRequest.current.abort(); beatRequest.current = null;
    setBeatAnalyzing(false); setBeatFeedback("选择或工程已变化，分析已取消；请重新分析。");
  }, [selection, project]);
  const [magnet, setMagnet] = useState(false);
  const [link, setLink] = useState(true);
  const [safeArea, setSafeArea] = useState(false);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({});
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [rendering, setRendering] = useState(false);
  const [renderMotion, setRenderMotion] = useState({ motionSamples: 1, shutterAngle: 180 });
  const [exporting, setExporting] = useState<"fcpxml" | "edl" | null>(null);
  const [result, setResult] = useState<NleRenderResult | null>(null);
  const [timelineResult, setTimelineResult] = useState<{ url: string; file: string; clips: number; textClips: number; warning?: string } | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"properties" | "assistant">("properties");
  const savedFilms = shared ? [] : readSavedProjects().filter(entry => entry.project);
  const [bridge, setBridge] = useState<NleBridge | null>(loaded.bridge ?? null);
  const [bridgeSource, setBridgeSource] = useState("");
  /** Draft for the duration field; committed as one trim on blur (see the inspector). */
  const [durationDraft, setDurationDraft] = useState<string | null>(null);
  const [startDraft, setStartDraft] = useState<string | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const trackMeters = useRef(new Map<string, HTMLSpanElement>());
  const updateTrackMeters = useCallback((levels: Record<string, number>) => {
    for (const [id, meter] of trackMeters.current) {
      const value = levels[id], bar = meter.firstElementChild as HTMLElement | null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        meter.removeAttribute("aria-valuenow"); meter.setAttribute("aria-valuetext", "未播放或电平不可用");
        if (bar) bar.style.width = "0%";
        continue;
      }
      const clamped = Math.max(-60, Math.min(0, value));
      meter.setAttribute("aria-valuenow", String(Math.round(clamped)));
      meter.setAttribute("aria-valuetext", `${value.toFixed(1)} dBFS`);
      if (bar) { bar.style.width = `${(clamped + 60) / 60 * 100}%`; bar.style.background = value > -1 ? "var(--danger)" : value > -12 ? "var(--warn)" : "var(--ok)"; }
    }
  }, []);
  const drag = useRef<{ startX: number; snapshot: NleProject; primary: Selection; selected: Selection[]; edge?: "start" | "end"; roll?: boolean } | null>(null);
  const ruler = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const duration = nleDurationMs(project);
  const primary = selection.at(-1) ?? null;
  const missingVisual = project.tracks.flatMap(track => track.clips).filter(clip => (clip.kind === "video" || clip.kind === "image") && !assets.some(asset => clip.src === `assets/${asset.name}`));
  useEffect(() => { setDurationDraft(null); setStartDraft(null); }, [primary?.clipId]);
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

  const persistCurrent = () => {
    if(shared)return;
    if(storageError)throw new Error(storageError);
    const durable=session.document(),next={project:JSON.stringify(durable),session:JSON.stringify(session.exportState())};
    if(!recordBytes.current.has(durable.id))throw new Error("剪辑工程库未载入此身份，未覆盖已有工程。");
    const raw=serializeNleRecord(next,bridge);
    saveNlePair(localStorage,storedPair.current,next,{key:nleRecordKey(durable.id),before:recordBytes.current.get(durable.id)!,after:raw});
    storedPair.current=next;recordBytes.current.set(durable.id,raw);
  };
  useEffect(() => {
    if(storageError)return;
    try {persistCurrent();}
    catch(cause){setStorageError(cause instanceof Error?cause.message:"剪辑保存失败，请导出当前工程备份。");}
  }, [project, session, storageError, bridge]);
  const assertUnchangedBeforeReload=()=>{
    if(storageError)throw new Error(storageError);
    const current={project:JSON.stringify(session.document()),session:JSON.stringify(session.exportState())};
    const diskPair=readNlePair(localStorage),diskRecord=localStorage.getItem(nleRecordKey(project.id));
    const consistent=diskRecord!==null&&JSON.stringify(parseNleRecord(diskRecord,project.id).pair)===JSON.stringify(diskPair);
    if(serializeNleRecord(current,bridge)!==recordBytes.current.get(project.id)||JSON.stringify(diskPair)!==JSON.stringify(storedPair.current)&&!consistent)throw new Error("当前剪辑还有未保存或不一致的修改，请先导出当前剪辑再载入恢复版本。");
  };
  const activateRecord=(raw:string,id:string,expected:string|null)=>{
    if(shared)throw new Error(sharedDocument.unavailable);
    if(storageError)throw new Error(storageError);
    const record=parseNleRecord(raw,id);
    if(id===project.id&&expected!==recordBytes.current.get(id)){
      // Explicitly opening a restored main-project snapshot may replace only an unchanged editor.
      assertUnchangedBeforeReload();storedPair.current=readNlePair(localStorage);
    }else persistCurrent();
    // Current project, undo history and its library record become active in one journaled write.
    saveNlePair(localStorage,storedPair.current,record.pair,{key:nleRecordKey(id),before:expected,after:raw});
    storedPair.current=record.pair;recordBytes.current.set(id,raw);
    projectEpoch.current++;cancelProjectRequests();
    beatRequest.current?.abort();beatRequest.current=null;
    setTranscripts({});setTranscribing(null);setBeatEnabled(false);setBeatBpm("120");setBeatOffset("0");setBeatDivision(1);setBeatMode("manual");setEstimatedBeats(null);setBeatAnalyzing(false);setBeatFeedback("");
    setDurationDraft(null);setStartDraft(null);setSnapGuide(null);setBridgeSource("");setRendering(false);setExporting(null);
    drag.current=null;ruler.current=false;setBand(null);bandStart.current=null;
    session.restore(JSON.parse(record.pair.session!));
    const next=session.document();projectRef.current=next;setProject(next);setBridge(record.bridge);
    setSelection([]);setPlaying(false);setPlayhead(0);setResult(null);setTimelineResult(null);setHistoryTick(value=>value+1);setError("");setLibraryOpen(false);
  };
  useEffect(()=>{
    if(shared||!active||storageError)return;
    try{const raw=localStorage.getItem(nleRecordKey(project.id));if(raw!==null&&raw!==recordBytes.current.get(project.id)){activateRecord(raw,project.id,raw);setStatus("已载入主工程恢复的剪辑版本。");}}
    catch(cause){setError(cause instanceof Error?cause.message:"剪辑恢复未接受，请先导出备份。");}
  },[active]);
  const openLibrary=()=>{try{if(localStorage.getItem(nleRecordKey(project.id))!==recordBytes.current.get(project.id))assertUnchangedBeforeReload();else persistCurrent();setLibrary(readNleLibrary(localStorage));setLibraryError("");setLibraryOpen(true);}catch(cause){setError(cause instanceof Error?cause.message:"工程库无法读取。");}};
  const openLibraryProject=(id:string)=>{try{
    const raw=localStorage.getItem(nleRecordKey(id));if(raw===null)throw new Error("剪辑工程已不存在。");
    if(id===project.id&&raw===recordBytes.current.get(id)){setLibraryOpen(false);return;}
    activateRecord(raw,id,raw);setStatus("已恢复剪辑工程及其撤销历史。");
  }catch(cause){setLibraryError(cause instanceof Error?cause.message:"未切换工程。");}};
  const createIndependent=(next:NleProject)=>{
    if(shared)return;
    const id=`nle-${crypto.randomUUID()}`,document=parseNleProject({...next,id});
    const fresh=createNleSession(document),pair={project:JSON.stringify(document),session:JSON.stringify(fresh.exportState())};
    activateRecord(serializeNleRecord(pair,null),id,null);
  };
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/media/library", { signal: controller.signal }).then(response => response.json()).then(data => {
      if (Array.isArray(data.assets)) setAssets(data.assets.filter((asset: Asset) => kindOf(asset.name)));
    }).catch(() => setError("素材库读取失败；仍可编辑文字轨和已保存工程。"));
    return () => controller.abort();
  }, []);

  const mutate = useCallback((next: NleProject, history = true) => {
    if(shared)return sharedDocument.commit(next);
    if (history) {
      const result = session.apply(next, "编辑时间线");
      if (!result.ok) { setError(result.reason); return false; }
      projectRef.current = result.document;
      setProject(result.document);
    } else {
      session.amendTo(next);
      projectRef.current = next;
      setProject(next);
    }
    setHistoryTick(value => value + 1);
    setError("");
    return true;
  }, [session]);

  const projectFromWorkbench = (requestedSourceId?:string) => {
    if(shared)return;
    const sourceId = requestedSourceId || bridgeSource || bridge?.sourceId || savedFilms[0]?.id;
    const entry = readSavedProjects().find(item => item.id === sourceId);
    if (!entry?.project) { setError("先在首页保存一个工程，再投影到剪辑台。"); return; }
    try {
      const existing=localStorage.getItem(nleRecordKey(entry.project.id));
      if(existing!==null){
        const record=parseNleRecord(existing,entry.project.id);
        const rebound=record.bridge?serializeNleRecord(record.pair,{...record.bridge,sourceId:entry.id}):existing;
        if(entry.project.id===project.id&&existing===recordBytes.current.get(project.id)&&rebound===existing){setStatus("当前就是此工程的剪辑，未重新投影或覆盖。");return;}
        activateRecord(rebound,entry.project.id,existing);setStatus(`已打开「${entry.name}」保存的剪辑；版本恢复的快照从新的撤销历史开始。`);return;
      }
      const projection = sceneScriptToNle(parseEditorProject(entry.project));
      const fresh=createNleSession(projection.nle),pair={project:JSON.stringify(projection.nle),session:JSON.stringify(fresh.exportState())};
      activateRecord(serializeNleRecord(pair,{sourceId:entry.id,projectId:projection.nle.id,links:projection.links}),projection.nle.id,null);
      setStatus(`已投影「${entry.name}」的 ${projection.links.length} 个场景，剪辑后点「回写工程」同步回作品。${projection.skippedAudio.length ? ` ${projection.skippedAudio.length} 段非本地配音未上音频轨。` : ""}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工程无法投影到时间线"); }
  };
  const openedRequest=useRef<number|undefined>(undefined);
  useEffect(()=>{if(active&&openRequest&&openedRequest.current!==openRequest.nonce){openedRequest.current=openRequest.nonce;projectFromWorkbench(openRequest.sourceId);}},[active,openRequest?.nonce]);
  const writeBackToWorkbench = () => {
    if (shared || !bridge) return;
    const entry = readSavedProjects().find(item => item.id === bridge.sourceId&&item.project?.id===project.id)??readSavedProjects().find(item=>item.project?.id===project.id);
    if (!entry?.project) { setError("源工程不在最近作品里；先回首页重新保存，再回写。"); return; }
    try {
      if(entry.project.id!==project.id || bridge.projectId!==project.id)throw new Error("源作品与当前剪辑身份不一致，未回写。");
      const result = applyNleToSceneScript(parseEditorProject(entry.project), { links: bridge.links }, project);
      saveProject({ ...entry, project: result.project });
      setStatus(`已回写 ${result.applied.length} 个片段的时长与顺序到「${entry.name}」${result.missing.length ? `；${result.missing.length} 个被删片段的场景按原时长保留` : ""}。回首页即可继续编辑或重新渲染。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "回写失败"); }
  };
  const local = (next: NleProject) => { if(shared&&!sharedDocument.previewProject(next))return; projectRef.current = next; setProject(next); setError(""); };
  const historyAction = useCallback((action: "undo" | "redo") => {
    if(shared){sharedDocument.history(action);return;}
    if(!session[action]())return;
    const document=session.document();projectRef.current=document;setProject(document);setHistoryTick(value=>value+1);
  }, [session]);
  const undo = () => historyAction("undo"), redo = () => historyAction("redo");
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
  /** AUDIO-03: transcribe the selected audio clip server-side (the browser never holds the LLM key), then lay caption segments on a text track. */
  const transcribeSelectedAudio = async () => {
    if (!primaryClip || primaryClip.clip.kind !== "audio" || transcribing) return;
    const epoch=projectEpoch.current;
    const clipId = primaryClip.clip.id;
    const url = audioAssets.get(clipId);
    if (!url) { setError("找不到该音频的素材地址。"); return; }
    const controller=new AbortController();projectRequests.current.add(controller);
    setTranscribing(clipId); setError("");
    try {
      const bytes = new Uint8Array(await (await fetch(url,{signal:controller.signal})).arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
      // ASR timestamps are source-file time; tell the model the real audio
      // length, then map each segment through this clip's trim/speed/curve.
      const sourceDurationMs = await new Promise<number>(resolve => {
        const probe = new Audio(applicationUrl(url));
        probe.preload = "metadata";
        const finish = (value: number) => { probe.src = ""; resolve(value); };
        probe.addEventListener("loadedmetadata", () => finish(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration * 1000 : 0), { once: true });
        probe.addEventListener("error", () => finish(0), { once: true });
        setTimeout(() => finish(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration * 1000 : 0), 4_000);
      });
      controller.signal.throwIfAborted();
      const fallbackMs = (primaryClip.clip.trimStartMs ?? 0) + primaryClip.clip.durationMs * (primaryClip.clip.speed ?? 1);
      const audioDurationMs = Math.min(3_600_000, Math.max(200, Math.round(sourceDurationMs >= 200 && sourceDurationMs <= 3_600_000 ? sourceDurationMs : fallbackMs)));
      const response = await fetch("/api/audio/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioBase64: btoa(binary), format: (primaryClip.clip as { src?: string }).src?.toLowerCase().endsWith(".wav") ? "wav" : "mp3", durationMs: audioDurationMs, diarize: true }), signal: AbortSignal.any([controller.signal,AbortSignal.timeout(200_000)]) });
      const transcript = await response.json() as Transcript & { error?: string };
      if(epoch!==projectEpoch.current)return;
      if (!response.ok) throw new Error(transcript.error ?? "转写失败");
      const latest = projectRef.current;
      const latestClip = latest.tracks.find(track => track.id === primaryClip.track.id)?.clips.find(clip => clip.id === clipId);
      if (!latestClip || latestClip.kind !== "audio" || latestClip.src !== primaryClip.clip.src) throw new Error("音频片段已被删除或替换，请重新选择后转写。");
      const textTrack = latest.tracks.find(track => track.kind === "text" && !track.locked);
      if (!textTrack) { setError("没有可用的文字轨；先添加一条文字轨再转写。"); return; }
      setTranscripts(current => ({ ...current, [clipId]: transcript }));
      let next = withTracks(latest, tracks => tracks.map(item => item.id === textTrack.id ? { ...item, clips: item.clips.filter(clip => !clip.id.startsWith(`asr-${clipId}`)) } : item));
      const cues = captionCuesForClip(transcript, latestClip);
      for (const cue of cues) {
        const caption: NleClip = { id: cue.id, kind: "text", text: cue.text, startMs: cue.startMs, durationMs: cue.durationMs, fontSize: 44, weight: 600, align: "center", karaoke: true, transitionIn: { type: "fade" } };
        next = withTracks(next, tracks => tracks.map(item => item.id === textTrack.id ? { ...item, clips: [...item.clips, caption] } : item));
      }
      mutate(next);
      setStatus(cues.length ? `已生成 ${cues.length} 条字幕，时间码按源素材与变速对齐` : "没有落在当前片段范围内的可直接用字幕");
    } catch (cause) { if(epoch===projectEpoch.current)setError(cause instanceof Error ? cause.message : "转写失败"); }
    finally { projectRequests.current.delete(controller);if(epoch===projectEpoch.current)setTranscribing(null); }
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
      // 联动开启时，删除主轨画面片段会带走重叠的字幕/叠加片段。
      if (link && track?.kind === "video") {
        const linked = removeMainWithLinked(next, item.trackId, item.clipId);
        next = linked.project;
        continue;
      }
      next = nleRemoveClip(next, item.trackId, item.clipId);
    }
    if (next !== project) { mutate(magnetized(next)); setSelection([]); }
  };
  const recordKeyframe = () => {
    if (!primary || !primaryClip || primaryClip.track.locked || primaryClip.clip.kind === "audio") return;
    try {
      const next = addMotionKeyframe(primaryClip.clip, playhead - primaryClip.clip.startMs, project.fps);
      patchClip({ keyframes: next.keyframes });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "关键帧未添加。 "); }
  };
  /** Razor across all tracks: split every unlocked clip the playhead crosses, one undo step (B key). */
  const razorAll = () => {
    let next = project, cuts = 0;
    for (const track of project.tracks) {
      if (track.locked) continue;
      for (const clip of track.clips) {
        const left = playhead - clip.startMs, right = clip.startMs + clip.durationMs - playhead;
        if (left >= 100 && right >= 100) { next = nleSplitClip(next, track.id, clip.id, playhead); cuts++; }
      }
    }
    if (!cuts) { setError("播放头没有跨过可切分的片段。"); return; }
    if (mutate(next)) setStatus(`剃刀已在播放头切分 ${cuts} 个片段`);
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
  const toggleTrack = (trackId: string, field: "muted" | "solo" | "locked") => {
    mutate(withTracks(project, tracks => tracks.map(track => track.id === trackId ? { ...track, [field]: !track[field] } : track)));
  };
  /** Magnetic track: when on, every unlocked video/overlay/text track re-joins head-to-tail after each edit (EDIT-02 全轨磁吸；音频轨自由摆放不参与). */
  const magnetized = (next: NleProject): NleProject => {
    if (!magnet) return next;
    let result = next;
    for (const track of next.tracks) {
      if (track.locked || track.kind === "audio" || track.clips.length < 2) continue;
      result = nleMagnetizeTrack(result, track.id);
    }
    return result;
  };
  const anySolo = project.tracks.some(track => track.solo);

  const validDetectedBeats = (snapshot: NleProject): EstimatedBeats | null => {
    if (!estimatedBeats) return null;
    const clip = snapshot.tracks.find(track => track.id === estimatedBeats.trackId)?.clips.find(item => item.id === estimatedBeats.clipId);
    return clip?.kind === "audio" && audioBeatSignature(estimatedBeats.trackId, clip) === estimatedBeats.signature ? estimatedBeats : null;
  };
  const analyzeSelectedBeats = async () => {
    if (beatRequest.current) return;
    const selected = primaryClip;
    if (!selected || selected.clip.kind !== "audio") { setBeatFeedback("请先选择音频片段。"); return; }
    const clip = selected.clip;
    if ((clip.speed ?? 1) !== 1 || clip.speedCurve || clip.speedRamp) { setBeatFeedback("暂只支持正常速度音频；变速片段请先恢复 1×。"); return; }
    if (clip.durationMs < 500 || clip.durationMs > 120_000) { setBeatFeedback("请选择时长 0.5–120 秒的音频片段。"); return; }
    const signature = audioBeatSignature(selected.track.id, clip), controller = new AbortController(); beatRequest.current = controller;
    setBeatAnalyzing(true); setEstimatedBeats(null); setBeatFeedback("正在本地分析音频能量峰值…");
    try {
      const response = await fetch("/api/nle/beats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: clip.src.slice("assets/".length), startMs: clip.trimStartMs ?? 0, durationMs: clip.durationMs }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(75_000)]) });
      const value = await response.json(); if (!response.ok) throw new Error(value?.error ?? "音频分析失败。");
      if (controller.signal.aborted) return;
      const current = projectRef.current.tracks.find(track => track.id === selected.track.id)?.clips.find(item => item.id === clip.id);
      if (current?.kind !== "audio" || audioBeatSignature(selected.track.id, current) !== signature || selectionRef.current.at(-1)?.trackId !== selected.track.id || selectionRef.current.at(-1)?.clipId !== clip.id) throw new Error("音频片段或选择在分析期间发生变化，请重新分析。");
      if (!Array.isArray(value?.beatsMs) || value.beatsMs.length > 1000 || value.beatsMs.some((ms: unknown, index: number) => !Number.isSafeInteger(ms) || (ms as number) < 0 || (ms as number) >= clip.durationMs || index > 0 && (ms as number) <= value.beatsMs[index - 1]) || typeof value?.bpm !== "number" || !Number.isFinite(value.bpm) || typeof value?.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw new Error("音频分析结果无效。");
      if (value.beatsMs.length < 2) throw new Error("可用峰值太少；请换一段节奏清晰的音频，或使用手动网格。");
      const absoluteBeats = value.beatsMs.map((ms: number) => clip.startMs + ms).filter((ms: number) => ms <= 21_600_000);
      if (absoluteBeats.length < 2) throw new Error("有效时间轴内的峰值太少，请调整片段后重试。");
      const calibration = parseBeatCalibration(value.calibration, clip.durationMs);
      setEstimatedBeats({ trackId: selected.track.id, clipId: clip.id, signature, beatsMs: absoluteBeats, bpm: value.bpm, sourceSha256: value.sourceSha256, calibration });
      setBeatFeedback(`音频 ${clip.id} 检测到 ${value.beatsMs.length} 个能量峰值${value.bpm > 0 ? ` · 估计 ${value.bpm} BPM` : ""}。峰值不一定是拍点；可手动选择音频峰值来源。${calibration ? "" : " 固定节拍候选不可用，请使用手动网格。"}`);
    } catch (cause) { if (!controller.signal.aborted) setBeatFeedback(cause instanceof Error ? cause.message : "音频分析失败。"); }
    finally { if (beatRequest.current === controller) { beatRequest.current = null; setBeatAnalyzing(false); } }
  };

  const snapValue = (snapshot: NleProject, valueMs: number, excludedClipIds: readonly string[]): number => {
    if (!snap) { setSnapGuide(null); return valueMs; }
    const points = nleSnapPoints(snapshot, { playheadMs: playhead, excludeClipIds: excludedClipIds });
    const estimated = beatMode === "audio" ? validDetectedBeats(snapshot) : null;
    const beats = !beatEnabled ? [] : beatMode === "audio" ? estimated ? onsetSnapCandidates(valueMs, estimated.beatsMs) : [] : beatBpm.trim() && beatOffset.trim() ? beatSnapCandidates(valueMs, { bpm: Number(beatBpm), offsetMs: Number(beatOffset), subdivisions: beatDivision }) : [];
    const point = nleSnap(valueMs, [...points, ...beats], SNAP_PX / pxPerMs);
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
    if(shared&&!sharedDocument.beginGesture())return;
    drag.current = { startX: event.clientX, snapshot: project, primary: target, selected, edge, roll: edge === "end" && event.altKey };
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
      // Alt+drag on the right edge rolls the shared boundary with the adjacent
      // right neighbour; without a neighbour the roll is a no-op and trim applies.
      const rolled = current.roll ? nleRollEdit(snapshot, current.primary.trackId, current.primary.clipId, applied) : null;
      const next = rolled && rolled !== snapshot ? rolled : nleTrimClip(snapshot, current.primary.trackId, current.primary.clipId, current.edge, applied);
      if(shared&&!sharedDocument.previewProject(next))return;
      projectRef.current = next;
      setProject(next);
      return;
    }
    const rawStart = Math.max(0, clip.startMs + delta);
    const snappedStart = Math.max(0, snapValue(snapshot, rawStart, excluded));
    const moving = current.selected.length ? current.selected : [current.primary];
    const starts = moving.flatMap(item => {
      const target = snapshot.tracks.find(candidate => candidate.id === item.trackId)?.clips.find(candidate => candidate.id === item.clipId);
      return target ? [target.startMs] : [];
    });
    // One shift for the whole selection: clamping each clip at zero would
    // shear their relative timing when the group is dragged past the origin.
    const main = mainTrackOf(snapshot);
    const mainIds = moving.filter(item => item.trackId === main?.id).map(item => item.clipId);
    const movingIds = moving.map(item => item.clipId);
    const shift = Math.max(
      snappedStart - clip.startMs,
      -Math.min(...starts),
      link && !current.edge && main && mainIds.length ? clampLinkedShift(snapshot, main.id, mainIds, snappedStart - clip.startMs, movingIds) : snappedStart - clip.startMs,
    );
    let next = snapshot;
    for (const item of moving) {
      const target = snapshot.tracks.find(candidate => candidate.id === item.trackId)?.clips.find(candidate => candidate.id === item.clipId);
      if (!target) continue;
      next = nleMoveClip(next, item.trackId, item.clipId, target.startMs + shift);
    }
    // 联动：主轨片段拖动时，重叠的字幕/叠加片段跟随同一偏移。
    if (link && !current.edge && main && mainIds.length) {
      const linked = moveLinkedClips(next, main.id, mainIds, shift, { excludeClipIds: movingIds });
      if (linked.moved) next = linked.project;
    }
    if(shared&&!sharedDocument.previewProject(next))return;
    projectRef.current = next;
    setProject(next);
  };
  const endDrag = () => {
    const current = drag.current; drag.current = null; setSnapGuide(null);
    if (!current) return;
    const latest = projectRef.current;
    if(shared){sharedDocument.endGesture(magnetized(latest));setHistoryTick(value=>value+1);return;}
    if (latest !== current.snapshot) {
      // Commit the complete local gesture, including magnetic re-join, once.
      const result = session.apply(magnetized(latest), "拖动编辑");
      if (result.ok) { projectRef.current = result.document; setProject(result.document); }
      else setError(result.reason);
    }
    setHistoryTick(value => value + 1);
  };
  const exportProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${project.id}.nle.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };
  const render = async (alpha = false) => {
    if (rendering) return;
    await executeNleRender({ project, alpha, motion: renderMotion, epoch: projectEpoch, requests: projectRequests, setRendering, setError, setStatus, setResult });
  };
  const exportTimeline = async (format: "fcpxml" | "edl") => {
    if (exporting) return;
    const epoch=projectEpoch.current;
    const controller=new AbortController();projectRequests.current.add(controller);
    setExporting(format); setError(""); setTimelineResult(null);
    try {
      const response = await fetch("/api/nle/timeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, format }), signal: AbortSignal.any([controller.signal,AbortSignal.timeout(60_000)]) });
      const data = await response.json();
      if(epoch!==projectEpoch.current)return;
      if (!response.ok || typeof data?.url !== "string") throw new Error(data?.error ?? "剪辑表导出失败");
      setTimelineResult({ url: data.url, file: data.file, clips: data.clips, textClips: data.textClips, warning: data.warning });
      setStatus(`已导出 ${format.toUpperCase()} · ${data.clips} 个事件`);
    } catch (cause) { if(epoch===projectEpoch.current)setError(cause instanceof Error ? cause.message : "剪辑表导出失败"); }
    finally { projectRequests.current.delete(controller);if(epoch===projectEpoch.current)setExporting(null); }
  };

  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const bandStart = useRef<{ x: number; y: number } | null>(null);
  // Container-relative band coordinates; GUTTER is the track-label column that
  // precedes t=0 inside the lanes element (mirrors --nle-gutter in nle-theme.css).
  const GUTTER = 168;
  const lanePoint = (event: React.PointerEvent) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const onLanesDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const point = lanePoint(event);
    // Only empty timeline space starts a marquee. Capturing pointers from the
    // track controls steals their click (including mute/solo/delete).
    if (point.x < GUTTER || (event.target as Element).closest('button, [role="button"], input, select, textarea')) return;
    bandStart.current = point;
    setBand({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer ids throw; the band still tracks while the button stays down. */ }
  };
  const onLanesMove = (event: React.PointerEvent) => {
    if (!bandStart.current) return;
    const point = lanePoint(event);
    setBand(current => current ? { ...current, x1: point.x, y1: point.y } : current);
  };
  const onLanesCancel = () => {
    bandStart.current = null;
    setBand(null);
  };
  const onLanesUp = (event: React.PointerEvent) => {
    const start = bandStart.current;
    const end = lanePoint(event);
    onLanesCancel();
    if (!start) return;
    // A pointer-up can arrive before React renders the final pointer-move.
    // Hit testing must use the released position, not the rendered marquee.
    const rect = { x0: start.x, y0: start.y, x1: end.x, y1: end.y };
    // Below ~6px in both axes it was a click: clear the selection and keep the
    // existing seek behaviour (the lane's own pointerdown already sought).
    if (Math.abs(rect.x1 - rect.x0) < 6 && Math.abs(rect.y1 - rect.y0) < 6) { setSelection([]); return; }
    const fromMs = Math.max(0, (Math.min(rect.x0, rect.x1) - GUTTER) / pxPerMs);
    const toMs = Math.max(0, (Math.max(rect.x0, rect.x1) - GUTTER) / pxPerMs);
    const top = Math.min(rect.y0, rect.y1), bottom = Math.max(rect.y0, rect.y1);
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
  const keys = useRef({ undo, redo, removeSelected, split, seek, playhead, duration, fps: project.fps, recordKeyframe, razorAll });
  keys.current = { undo, redo, removeSelected, split, seek, playhead, duration, fps: project.fps, recordKeyframe, razorAll };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable=true]")) return;
      const current = keys.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? current.redo() : current.undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); current.redo(); return; }
      if (event.key === " ") { event.preventDefault(); setPlaying(value => !value); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); current.removeSelected(); return; }
      if (event.key.toLowerCase() === "s" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); current.split(); return; }
      if (event.key.toLowerCase() === "k" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); current.recordKeyframe(); return; }
      if (event.key.toLowerCase() === "b" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); current.razorAll(); return; }
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) { event.preventDefault(); setShortcutsOpen(value => !value); return; }
      if (event.key === "Escape") setShortcutsOpen(false);
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

  return <>{sharedDocument.panel}<section className="nle-editor" aria-label="剪辑台" tabIndex={-1} data-history={historyTick}>
    {!shared && archiveOpen && <dialog ref={node=>{if(node&&!node.open)node.showModal();}} aria-label="剪辑完整备份" onClose={()=>setArchiveOpen(false)} style={{maxWidth:640,width:"calc(100vw - 48px)",background:"var(--ink-2)",color:"var(--paper)",padding:24}}>
      <h2>剪辑完整备份</h2><p>打包当前时间线与所用媒体。导入保留原工程，新副本从当前时间线开始编辑；撤销历史和源作品关联不包含在 ZIP 中。</p>
      <ProjectArchivePanel key={project.id} kind="nle" project={project} getStorageSignature={()=>JSON.stringify([localStorage.getItem(STORAGE),localStorage.getItem(SESSION_STORAGE),localStorage.getItem(nleRecordKey(project.id))])} onApply={()=>false} onCopy={(next,documents,workspace)=>{if(documents?.length||workspace)throw new Error("此剪辑包包含额外页面或脚本，当前剪辑入口不能完整恢复，请保留原包。");createIndependent(parseNleProject(next));setStatus("已恢复独立剪辑及素材，原工程保留。");return true;}}/>
      <button className="g-btn" onClick={()=>setArchiveOpen(false)}>关闭备份</button>
    </dialog>}
    {libraryOpen && <dialog ref={node=>{if(node&&!node.open)node.showModal();}} aria-label="剪辑工程库" onClose={()=>setLibraryOpen(false)} style={{maxWidth:560,width:"calc(100vw - 48px)",background:"var(--ink-2)",color:"var(--paper)",border:"1px solid var(--line-2)",borderRadius:12,padding:20}}>
      <h2>剪辑工程库</h2><p>每个工程独立保存时间线、撤销记录和源作品关联。</p>
      {library.map(item=><button className="g-btn" key={item.id} onClick={()=>openLibraryProject(item.id)} style={{display:"block",width:"100%",textAlign:"left",marginBottom:8}}>{item.title}{item.id===project.id?" · 当前":""}</button>)}
      {libraryError&&<p role="alert">{libraryError}</p>}<button className="g-btn" onClick={()=>setLibraryOpen(false)}>关闭工程库</button>
    </dialog>}
    <header className="nle-bar">
      <div className="nle-id">
        <span className="nle-mark" aria-hidden="true" />
        <input aria-label="剪辑标题" className="nle-title" value={project.title} onChange={event => mutate(parseNleProject({ ...project, title: event.target.value || "未命名剪辑" }), false)} />
        <span className="nle-spec g-num">{project.width}×{project.height} · {project.fps}fps · {(duration / 1000).toFixed(1)}s{selection.length > 1 ? ` · 已选 ${selection.length}` : ""}</span>
      </div>
      <div className="nle-clock" aria-label="时间码">
        <span className="nle-clock-now g-num">{timecodeOf(playhead)}</span>
        <span className="nle-clock-total g-num">/ {timecodeOf(duration)}</span>
      </div>
      <div className="nle-bar-actions">
        <button type="button" aria-label="撤销" className="g-btn g-btn--sm g-btn--quiet" disabled={!session.undoDepth()} onClick={undo} title="Ctrl+Z">撤销</button>
        <button type="button" aria-label="重做" className="g-btn g-btn--sm g-btn--quiet" disabled={!session.redoDepth()} onClick={redo} title="Ctrl+Shift+Z">重做</button>
        <span className="g-vrule" aria-hidden="true" />
        <NleProjectSettings project={project} onApply={next => { const applied = mutate(next, true); if (applied) setStatus(`规格已更新：${next.width}×${next.height} · ${next.fps} fps，可撤销。`); return applied; }} />
        <details className="nle-menu-wrap">
          <summary className="g-btn g-btn--sm g-btn--quiet">工程</summary>
          <div className="g-menu nle-menu">
            {savedFilms.length > 0 && <select aria-label="投影源工程" className="g-field" value={bridgeSource || bridge?.sourceId || savedFilms[0]!.id} onChange={event => setBridgeSource(event.target.value)}>{savedFilms.map(film => <option key={film.id} value={film.id}>{film.name.slice(0, 18)}</option>)}</select>}
            <button type="button" disabled={!savedFilms.length} onClick={()=>projectFromWorkbench()} title="把最近作品投影成时间线">从工程投影</button>
            {bridge && <button type="button" onClick={writeBackToWorkbench} title="把时长/顺序写回源作品">回写工程</button>}
            <button type="button" disabled={Boolean(shared)} onClick={openLibrary}>剪辑工程库</button>
            <button type="button" disabled={Boolean(shared)} onClick={()=>{try{createIndependent(defaultProject());setStatus("已新建独立剪辑，原工程保留在工程库。");}catch(cause){setError(cause instanceof Error?cause.message:"未新建工程。");}}}>新建剪辑</button>
            <button type="button" disabled={Boolean(shared)} onClick={() => importRef.current?.click()}>导入 NLE</button>
            <button type="button" onClick={exportProject}>导出 NLE JSON</button>
            <button type="button" disabled={Boolean(shared)||!isLocalAgentAvailable()} title={isLocalAgentAvailable()?"打包时间线与所用媒体":"完整素材打包需使用 Windows 桌面客户端；Web 可导出 NLE JSON"} onClick={()=>setArchiveOpen(true)}>剪辑完整备份</button>
            <NleProposal project={project} onApply={next => { const applied = mutate(next, true); if (applied) { setSelection([]); setStatus("已应用提案，可撤销。"); } return applied; }} />
          </div>
        </details>
        <details className="nle-menu-wrap">
          <summary className="g-btn g-btn--sm g-btn--quiet">导出</summary>
          <div className="g-menu nle-menu">
            <NleRenderOptions project={project} value={renderMotion} onChange={setRenderMotion} disabled={rendering} />
            <button type="button" disabled={exporting !== null} onClick={() => void exportTimeline("fcpxml")}>{exporting === "fcpxml" ? "导出中…" : "FCPXML"}</button>
            <button type="button" disabled={exporting !== null} onClick={() => void exportTimeline("edl")}>{exporting === "edl" ? "导出中…" : "EDL"}</button>
            <button type="button" disabled={rendering} title="仅文字叠加和音频；图片或视频片段需先移除，导出 WebM VP9 Alpha" onClick={() => void render(true)}>透明 WebM</button>
          </div>
        </details>
        <button type="button" className="g-btn g-btn--primary" disabled={rendering} onClick={() => void render()}>{rendering ? "渲染中…" : "渲染 MP4"}</button>
        {onClose && <button type="button" className="g-btn g-btn--sm g-btn--quiet nle-back" onClick={onClose}>返回首页</button>}
        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if(file.size>8*1024*1024)throw new Error("NLE 文件超过 8 MiB。");createIndependent(parseNleProject(JSON.parse(await file.text()))); setStatus("已导入为独立剪辑，原工程保留。"); } catch(cause) { setError(cause instanceof Error?cause.message:"NLE 工程无法解析"); } finally { event.target.value = ""; } }} />
      </div>
    </header>

    {storageError&&<div role="alert" className="nle-alert">{storageError} 当前编辑仅保留在窗口中，请先备份再关闭。
      <button type="button" className="g-btn g-btn--sm" onClick={exportProject}>导出当前 NLE JSON</button>
      <button type="button" className="g-btn g-btn--sm" onClick={()=>{try{downloadJson("glint-nle-original-records.json",{format:"glint.nle.raw-backup",version:1,records:Object.fromEntries([STORAGE,SESSION_STORAGE,"glint.nle.project.v1","glint.nle.save.v1",BRIDGE_STORAGE,nleRecordKey(project.id)].map(key=>[key,localStorage.getItem(key)]))});}catch{setError("原始剪辑记录无法读取，请保留客户端数据目录。");}}}>备份原始剪辑记录</button>
    </div>}
    <div className="nle-body">
      <NleLibrary project={project} target={primary} assets={assets} onAddText={addText} onAddAsset={addAsset} onApply={mutate} />

      <div className="nle-center">
        <div className="nle-stage">
          <div className="nle-stage-fit">
            <NlePreview project={project} mediaAssetBase={applicationUrl("/api/media/assets/")} tMs={playhead} playing={playing} showSafeArea={safeArea} onTimeUpdate={setPlayhead} onEnded={() => setPlaying(false)} onTrackLevels={updateTrackMeters} />
          </div>
          {missingVisual.length > 0 && <p className="nle-media-warning" role="status">{missingVisual.length} 个画面素材不在素材库：{missingVisual.slice(0, 2).map(clip => clip.id).join("、")}{missingVisual.length > 2 ? " 等" : ""}。加入素材，或用「从工程投影」重建时间线。</p>}
          {project.tracks.every(track => track.clips.length === 0) && <div className="nle-empty">
            <span className="g-label">Empty timeline</span>
            <strong>把素材加入时间线</strong>
            <p>从左侧素材库添加片段，或用「从工程投影」把一支作品展开成多轨工程。</p>
          </div>}
        </div>
        {/* Transport: the play head and the edit tools live on one hairline strip. */}
        <div className="nle-transport">
          <div role="group" aria-label="播放控制" className="nle-play">
            <button type="button" aria-label="跳到开头" className="g-btn g-btn--icon g-btn--sm" onClick={() => seek(0)}><svg aria-hidden viewBox="0 0 16 16"><path d="M3.4 3h1.6v10H3.4zM13 3.6 6.4 8 13 12.4z" fill="currentColor" /></svg></button>
            <button type="button" aria-label="上一帧" className="g-btn g-btn--icon g-btn--sm" onClick={() => seek(playhead - Math.round(1000 / project.fps))}><svg aria-hidden viewBox="0 0 16 16"><path d="M11.2 3.6 4.6 8l6.6 4.4z" fill="currentColor" /></svg></button>
            <button type="button" aria-label={playing ? "暂停" : "播放"} className="nle-play-btn" data-playing={playing || undefined} onClick={() => setPlaying(value => !value)}>
              {playing
                ? <svg aria-hidden viewBox="0 0 16 16"><path d="M5 3.2h2.4v9.6H5zM8.8 3.2H11v9.6H8.8z" fill="currentColor" /></svg>
                : <svg aria-hidden viewBox="0 0 16 16"><path d="M5.4 3.2 12.8 8l-7.4 4.8z" fill="currentColor" /></svg>}
            </button>
            <button type="button" aria-label="下一帧" className="g-btn g-btn--icon g-btn--sm" onClick={() => seek(playhead + Math.round(1000 / project.fps))}><svg aria-hidden viewBox="0 0 16 16"><path d="M4.8 3.6 11.4 8l-6.6 4.4z" fill="currentColor" /></svg></button>
            <button type="button" aria-label="跳到结尾" className="g-btn g-btn--icon g-btn--sm" onClick={() => seek(duration)}><svg aria-hidden viewBox="0 0 16 16"><path d="M3 3.6 9.6 8 3 12.4zM11 3h1.6v10H11z" fill="currentColor" /></svg></button>
          </div>
          <span className="g-vrule" aria-hidden="true" />
          <div className="nle-tools">
            <button type="button" className="g-btn g-btn--sm" disabled={!primaryClip} onClick={split} title="S">在播放头切分</button>
            <button type="button" className="g-btn g-btn--sm" onClick={razorAll} title="B · 全轨">剃刀全轨</button>
            <button type="button" className="g-btn g-btn--sm" disabled={!primaryClip} onClick={recordKeyframe} title="K · 在播放头记录关键帧">＋ 关键帧</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" disabled={!primaryClip} onClick={duplicate}>复制片段</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" disabled={!selection.length} onClick={removeSelected}>删除片段</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet nle-tools-end" onClick={() => setShortcutsOpen(true)} title="?">快捷键</button>
          </div>
        </div>
        <div className="nle-status">
          {status && <span role="status">{status}</span>}
          {/* K-03: read-only impact preview for the shared container timeline; after an
              export the receipt's elapsedMs feeds the preview-vs-actual line. */}
          {shared && <ContainerPlanPreview projectId={shared.projectId} intent={{ objectIds: [shared.objectId] }} actualMs={result?.elapsedMs ?? null} />}
          {result && <a href={applicationUrl(result.url)} download={result.file}>下载 {result.file.endsWith(".webm") ? "透明 WebM" : "MP4"}</a>}
          {result && <DeliveryPanel receipt={{ file: result.file, url: result.url, coverUrl: result.coverUrl, verify: result.verify }} />}
          {timelineResult && <a href={applicationUrl(timelineResult.url)} download={timelineResult.file}>下载 {timelineResult.file.endsWith(".fcpxml") ? "FCPXML" : "EDL"}（{timelineResult.clips} 事件）</a>}
        </div>
        <details className="nle-beat-panel">
          <summary>节拍吸附</summary>
          <div className="nle-beat-body">
            <div className="nle-beat-row">
              <label className="nle-toggle"><input aria-label="启用节拍吸附" type="checkbox" checked={beatEnabled} onChange={event => setBeatEnabled(event.target.checked)} />节拍吸附</label>
              <label className="nle-inline">来源<select aria-label="节拍来源" className="g-field" value={beatMode} onChange={event => setBeatMode(event.target.value as "manual" | "audio")}><option value="manual">手动网格</option><option value="audio">音频峰值（估计）</option></select></label>
              {beatMode === "manual" && <>
                <label className="nle-inline">BPM<input aria-label="节拍 BPM" className="g-field nle-num" type="number" min="30" max="300" step="0.01" value={beatBpm} onChange={event => setBeatBpm(event.target.value)} /></label>
                <label className="nle-inline">首拍偏移 ms<input aria-label="首拍偏移 ms" className="g-field nle-num" type="number" min="0" max="21600000" step="0.1" value={beatOffset} onChange={event => setBeatOffset(event.target.value)} /></label>
                <label className="nle-inline">细分<select aria-label="节拍细分" className="g-field" value={beatDivision} onChange={event => setBeatDivision(Number(event.target.value) as ManualBeatGrid["subdivisions"])}><option value={1}>整拍</option><option value={2}>半拍</option><option value={4}>四分之一拍</option></select></label>
              </>}
            </div>
            <div className="nle-beat-row">
              <button type="button" className="g-btn g-btn--sm" disabled={beatAnalyzing || primaryClip?.clip.kind !== "audio"} onClick={() => void analyzeSelectedBeats()}>{beatAnalyzing ? "分析音频中…" : "分析选中音频"}</button>
              {beatAnalyzing && <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => { beatRequest.current?.abort(); setBeatFeedback("已取消本地分析。"); }}>取消分析</button>}
            </div>
            <small className="nle-note">在当前 Glint 服务分析源音频片段，不发送网关；不包含音量、淡入淡出或混音效果。能量峰值只是估计，可能漏拍或误判。仅支持正常速度、0.5–120 秒的素材库音频。需同时开启“吸附”；设置本次打开有效，已对齐的剪辑时间会保存。</small>
            {beatFeedback && <p role="status" className="nle-beat-feedback">{beatFeedback}</p>}
            <NleBeatCalibration calibration={validDetectedBeats(project)?.calibration ?? null} clip={(() => {
              const result = validDetectedBeats(project);
              if (!result || primary?.trackId !== result.trackId || primary.clipId !== result.clipId || primaryClip?.clip.kind !== "audio") return null;
              const clip = primaryClip.clip;
              return { src: clip.src, startMs: clip.startMs, trimStartMs: clip.trimStartMs ?? 0, durationMs: clip.durationMs, signature: result.signature };
            })()} button={plainButton} onApply={grid => { setBeatBpm(String(grid.bpm)); setBeatOffset(String(grid.offsetMs)); setBeatDivision(grid.subdivisions); setBeatMode("manual"); setBeatEnabled(true); setSnap(true); }} />
            {beatMode === "audio" && !validDetectedBeats(project) && <p role="status" className="nle-note">没有可用的当前音频分析；请选择音频并重新分析。音频片段移动、裁剪或换素材后需重新分析。</p>}
            {beatMode === "manual" && beatEnabled && (!beatBpm.trim() || !beatOffset.trim() || !beatSnapCandidates(0, { bpm: Number(beatBpm), offsetMs: Number(beatOffset), subdivisions: beatDivision }).length) && <p role="alert" className="nle-note nle-note--warn">BPM 需为 30–300，首拍偏移需为 0–21600000 ms。</p>}
          </div>
        </details>
        {timelineResult?.warning && <small role="status" className="nle-note nle-note--warn">{timelineResult.warning}</small>}
      </div>

      <aside aria-label="片段属性" className="nle-inspector">
        <div className="nle-insp-head">
          <div className="g-seg" role="group" aria-label="编辑侧栏">
            <button type="button" aria-pressed={inspectorTab === "properties"} onClick={() => setInspectorTab("properties")}>片段属性</button>
            <button type="button" aria-pressed={inspectorTab === "assistant"} onClick={() => setInspectorTab("assistant")}>创作助手</button>
          </div>
        </div>
        <div className="nle-insp-body nle-insp-body--chat" hidden={inspectorTab !== "assistant"}>
          {inspectorTab === "assistant" && <LocalAgentChat project={project} kind="nle" context={{ clipIds: [...selectedIds], timeMs: playhead }} onSeek={seek}
            onApply={next => mutate(parseNleProject(next), true)} />}
        </div>
        <div className="nle-insp-body" hidden={inspectorTab !== "properties"}>
        {!primaryClip ? <div className="nle-insp-idle">
          <span className="g-label">未选择</span>
          <p>选一个片段开始调整。Shift+点击可多选。</p>
        </div> : <>
          <div className="nle-insp-id">
            <strong>{primaryClip.clip.kind === "text" ? "文字片段" : primaryClip.clip.kind === "audio" ? "音频片段" : primaryClip.clip.kind === "image" ? "图片片段" : "视频片段"}</strong>
            <small className="g-num">{primaryClip.track.name} · {primaryClip.clip.id}{selection.length > 1 ? ` · +${selection.length - 1}` : ""}</small>
          </div>

          <section className="nle-group">
            <span className="g-label">时间</span>
            <div className="nle-grid-2">
              <label className="nle-field">起点 ms<input aria-label="起点 ms" className="g-field g-num" type="number" value={startDraft ?? primaryClip.clip.startMs} onBlur={() => { const draft = startDraft; setStartDraft(null); if (draft !== null && Number.isFinite(Number(draft)) && Math.round(Number(draft)) !== primaryClip.clip.startMs) mutate(nleMoveClip(projectRef.current, primary!.trackId, primary!.clipId, Math.max(0, Math.round(Number(draft)))), true); }} onChange={event => setStartDraft(event.target.value)} /></label>
              <label className="nle-field">时长 ms<input aria-label="时长 ms" className="g-field g-num" type="number" min={100} value={durationDraft ?? primaryClip.clip.durationMs} onBlur={() => {
                const draft = durationDraft;
                setDurationDraft(null);
                // Commit once on blur: trimming per keystroke feeds back into the
                // value mid-edit and lets intermediate states ("2", "20", "200") explode the duration.
                if (draft !== null && Number.isFinite(Number(draft)) && Math.round(Number(draft)) !== primaryClip.clip.durationMs) mutate(nleTrimClip(projectRef.current, primary!.trackId, primary!.clipId, "end", Math.round(Number(draft)) - primaryClip.clip.durationMs), true);
              }} onChange={event => setDurationDraft(event.target.value)} /></label>
            </div>
            <label className="nle-field">速度<span className="nle-field-value g-num">{(primaryClip.clip.speed ?? 1).toFixed(2)}×</span><input type="range" className="nle-range" min="0.25" max="4" step="0.05" value={primaryClip.clip.speed ?? 1} onChange={event => patchClip({ speed: Number(event.target.value) })} /></label>
            <label className="nle-field">速度曲线<select aria-label="速度曲线" className="g-field" value={primaryClip.clip.speedCurve ?? "linear"} onChange={event => patchClip({ speedCurve: event.target.value === "linear" ? undefined : event.target.value as NonNullable<NleClip["speedCurve"]> })}><option value="linear">线性（匀速）</option><option value="in">缓入（慢→快）</option><option value="out">缓出（快→慢）</option><option value="bell">钟形（慢快慢）</option></select></label>
          </section>

          {(primaryClip.clip.kind === "audio" || primaryClip.clip.kind === "video") && <section className="nle-group">
            <span className="g-label">声音</span>
            <label className="nle-field">音量<span className="nle-field-value g-num">{Math.round((primaryClip.clip.volume ?? 1) * 100)}%</span><input type="range" className="nle-range" min="0" max="1" step="0.01" value={primaryClip.clip.volume ?? 1} onChange={event => patchClip({ volume: Number(event.target.value) })} /></label>
          </section>}

          {primaryClip.clip.kind === "audio" && <section className="nle-group">
            <span className="g-label">字幕</span>
            <button type="button" className="g-btn g-btn--sm" disabled={Boolean(transcribing)} onClick={() => void transcribeSelectedAudio()}>{transcribing === primaryClip.clip.id ? "正在转写…" : "智能转写字幕"}</button>
            {transcripts[primaryClip.clip.id] && <small className="nle-note">已生成 {transcripts[primaryClip.clip.id]!.segments.length} 条字幕（时间码为比例估计）</small>}
          </section>}

          {primaryClip.clip.kind === "text" && <section className="nle-group">
            <span className="g-label">文字</span>
            <label className="nle-field">内容<textarea rows={3} className="g-field" value={primaryClip.clip.text} onChange={event => patchClip({ text: event.target.value || " " })} /></label>
            <div className="nle-grid-2">
              <label className="nle-field">字号<input type="number" className="g-field g-num" min={12} max={240} value={primaryClip.clip.fontSize ?? 72} onChange={event => patchClip({ fontSize: Number(event.target.value) })} /></label>
              <label className="nle-field">颜色<input type="color" className="nle-color" value={primaryClip.clip.color ?? "var(--paper)"} onChange={event => patchClip({ color: event.target.value })} /></label>
            </div>
            <div className="nle-grid-2">
              <label className="nle-field">对齐<select className="g-field" value={primaryClip.clip.align ?? "center"} onChange={event => patchClip({ align: event.target.value as "left" | "center" | "right" })}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label>
              <label className="nle-field">字重<select className="g-field" value={primaryClip.clip.weight ?? 600} onChange={event => patchClip({ weight: Number(event.target.value) as 400 | 600 | 700 | 800 })}><option value={400}>常规</option><option value={600}>半粗</option><option value={700}>粗</option><option value={800}>特粗</option></select></label>
            </div>
          </section>}

          {primaryClip.clip.kind !== "audio" && <>
            <section className="nle-group">
              <span className="g-label">画面</span>
              <div className="nle-grid-4">
                {(["x", "y", "scale", "rotate"] as const).map(key => <ScrubLabel key={key} value={primaryClip.clip.transform?.[key] ?? (key === "scale" ? 1 : 0)} step={key === "scale" ? 0.05 : key === "rotate" ? 1 : 0.01} min={key === "scale" ? 0.05 : key === "rotate" ? -180 : -1} max={key === "scale" ? 8 : key === "rotate" ? 180 : 1} onCommit={next => patchClip({ transform: { ...primaryClip.clip.transform, [key]: Number(next.toFixed(2)) } } as Partial<NleClip>)}>{key}</ScrubLabel>)}
              </div>
              <label className="nle-field">不透明度<span className="nle-field-value g-num">{Math.round((primaryClip.clip.opacity ?? 1) * 100)}%</span><input type="range" className="nle-range" min="0" max="1" step="0.01" value={primaryClip.clip.opacity ?? 1} onChange={event => patchClip({ opacity: Number(event.target.value) })} /></label>
              <div className="nle-grid-2">
                <label className="nle-field">混合<select aria-label="混合模式" className="g-field" value={primaryClip.clip.blend ?? "normal"} onChange={event => patchClip({ blend: event.target.value === "normal" ? undefined : event.target.value as NonNullable<NleClip["blend"]> })}>{["normal", "screen", "multiply", "overlay", "darken", "lighten", "soft-light"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="nle-field">蒙版<select aria-label="蒙版形状" className="g-field" value={primaryClip.clip.mask?.shape ?? ""} onChange={event => patchClip({ mask: event.target.value ? { shape: event.target.value as "circle" | "rect", feather: primaryClip.clip.mask?.feather ?? 0.08, inset: primaryClip.clip.mask?.inset ?? 0.05 } : undefined })}><option value="">无</option><option value="circle">圆形</option><option value="rect">矩形</option></select></label>
              </div>
              {primaryClip.clip.mask && <>
                <label className="nle-field">羽化<span className="nle-field-value g-num">{Math.round((primaryClip.clip.mask.feather ?? 0) * 100)}%</span><input aria-label="蒙版羽化" className="nle-range" type="range" min="0" max="0.5" step="0.01" value={primaryClip.clip.mask.feather ?? 0} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, feather: Number(event.target.value) } })} /></label>
                {primaryClip.clip.mask.shape === "rect" && <label className="nle-field">内缩<span className="nle-field-value g-num">{Math.round((primaryClip.clip.mask.inset ?? 0) * 100)}%</span><input aria-label="蒙版内缩" className="nle-range" type="range" min="0" max="0.45" step="0.01" value={primaryClip.clip.mask.inset ?? 0} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, inset: Number(event.target.value) } })} /></label>}
                <label className="nle-toggle"><input aria-label="反转蒙版" type="checkbox" checked={Boolean(primaryClip.clip.mask.invert)} onChange={event => patchClip({ mask: { ...primaryClip.clip.mask!, invert: event.target.checked || undefined } })} />反转</label>
              </>}
            </section>

            <section className="nle-group">
              <span className="g-label">转场</span>
              <div className="nle-grid-2">
                <label className="nle-field">入场<select aria-label="入场转场" className="g-field" value={primaryClip.clip.transitionIn?.type ?? ""} onChange={event => patchClip({ transitionIn: event.target.value ? { type: event.target.value as ClipTransitionType, durationMs: primaryClip.clip.transitionIn?.durationMs ?? DEFAULT_FADE_MS } : undefined })}>{TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="nle-field">出场<select aria-label="出场转场" className="g-field" value={primaryClip.clip.transitionOut?.type ?? ""} onChange={event => patchClip({ transitionOut: event.target.value ? { type: event.target.value as ClipTransitionType, durationMs: primaryClip.clip.transitionOut?.durationMs ?? DEFAULT_FADE_MS } : undefined })}>{TRANSITIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              </div>
              {(primaryClip.clip.transitionIn || primaryClip.clip.transitionOut) && <label className="nle-field">转场时长 ms<input aria-label="转场时长 ms" className="g-field g-num" type="number" min={100} max={5000} step={50} value={primaryClip.clip.transitionIn?.durationMs ?? primaryClip.clip.transitionOut?.durationMs ?? DEFAULT_FADE_MS} onChange={event => { const durationMs = Math.min(5000, Math.max(100, Number(event.target.value))); patchClip({ ...(primaryClip.clip.transitionIn ? { transitionIn: { ...primaryClip.clip.transitionIn, durationMs } } : {}), ...(primaryClip.clip.transitionOut ? { transitionOut: { ...primaryClip.clip.transitionOut, durationMs } } : {}) }); }} /></label>}
              <small className="nle-note">转场在当前片段内部完成，不需要相邻片段重叠。预览与导出逐帧一致。</small>
            </section>

            <section className="nle-group">
              <div className="nle-group-head">
                <span className="g-label">关键帧 {primaryClip.clip.keyframes?.length ?? 0}</span>
                <div className="nle-group-tools">
                  <button type="button" aria-label="在播放头记录关键帧" className="g-btn g-btn--sm g-btn--quiet" onClick={() => {
                    recordKeyframe();
                  }}>＋ 记录</button>
                  <button type="button" aria-label="清除关键帧" className="g-btn g-btn--sm g-btn--quiet" disabled={!primaryClip.clip.keyframes?.length} onClick={() => patchClip({ keyframes: undefined })}>清除</button>
                </div>
              </div>
              {(primaryClip.clip.keyframes ?? []).map((frame, index) => <div key={frame.ms} className="nle-key-row">
                <span className="nle-key-meta g-num">{frame.ms}ms · {Math.round((frame.opacity ?? 1) * 100)}% · {Number(frame.scale ?? 1).toFixed(2)}×</span>
                <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => seek(primaryClip.clip.startMs + frame.ms)}>定位</button>
                <button type="button" aria-label={`删除关键帧 ${frame.ms}`} className="g-btn g-btn--icon g-btn--sm g-btn--quiet" onClick={() => patchClip({ keyframes: primaryClip.clip.keyframes!.filter((_, i) => i !== index) })}>×</button>
              </div>)}
              <details className="nle-disclosure">
                <summary>编辑曲线与运动路径</summary>
                <NleMotionEditor clip={primaryClip.clip} fps={project.fps} playheadMs={playhead}
                  locked={Boolean(primaryClip.track.locked)} onSeek={seek}
                  onChange={clip => patchClip({ keyframes: clip.keyframes })} />
              </details>
            </section>
          </>}
        </>}
        {error && <p role="alert" className="nle-alert">{error}</p>}
        </div>
      </aside>
    </div>

    <TimelineDock storageKey={`nle:${project.id}`} label={t("timelineDock.timeline")}><div aria-label="多轨时间线" className="nle-timeline">
      <div className="nle-tl-bar">
        <span className="g-label">时间线</span>
        <div className="nle-tl-add">
          {TRACK_KINDS.map(item => <button key={item.kind} type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => addTrack(item.kind)}>{item.label}</button>)}
        </div>
        <div className="nle-tl-view">
          <label className="nle-inline nle-zoom">缩放<input aria-label="时间线缩放" className="nle-range" type="range" min="0.01" max="0.3" step="0.005" value={pxPerMs} onChange={event => setPxPerMs(Number(event.target.value))} /></label>
          <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={fit}>适配</button>
          <span className="g-vrule" aria-hidden="true" />
          <label className="nle-toggle"><input aria-label="吸附" type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />吸附</label>
          <label className="nle-toggle" title="开启后，画面/叠加/字幕轨片段在每次编辑后自动首尾相接；音频轨自由摆放"><input aria-label="主轨磁吸" type="checkbox" checked={magnet} onChange={event => setMagnet(event.target.checked)} />磁吸</label>
          <label className="nle-toggle" title="开启后，删除或拖动主轨画面片段时，重叠的字幕与叠加片段跟随移动或删除"><input aria-label="联动" type="checkbox" checked={link} onChange={event => setLink(event.target.checked)} />联动</label>
          <label className="nle-toggle" title="在预览上叠加各画幅的安全区参考线；参考线只出现在预览，不会进入导出"><input aria-label="安全区" type="checkbox" checked={safeArea} onChange={event => setSafeArea(event.target.checked)} />安全区</label>
        </div>
      </div>
      <div className="nle-tl-scroll g-scroll">
        <div className="nle-tl-inner" style={{ width: width + GUTTER, "--nle-tick": `${tickMs * pxPerMs}px` } as CSSProperties}>
          <div className="nle-tl-ruler-row">
            <span className="nle-tl-gutter g-label">轨道</span>
            <div aria-label="时间标尺" className="nle-ruler"
              onPointerDown={event => { if (event.button !== 0) return; ruler.current = true; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional */ } }}
              onPointerMove={event => { if (!ruler.current) return; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); }}
              onPointerUp={() => { ruler.current = false; }} onPointerCancel={() => { ruler.current = false; }}>
              {Array.from({ length: ticks }, (_, index) => <span key={index} className="nle-tick g-num" style={{ left: index * tickMs * pxPerMs }}>{(index * tickMs / 1000).toFixed(tickMs >= 1000 ? 0 : 1)}s</span>)}
            </div>
          </div>
          <div ref={lanesRef} className="nle-lanes" onPointerDown={onLanesDown} onPointerMove={onLanesMove} onPointerUp={onLanesUp} onPointerCancel={onLanesCancel}>
          {project.tracks.map(track => <div key={track.id} className="nle-track" data-kind={track.kind} data-dim={track.muted || (anySolo && !track.solo && track.kind === "audio") || undefined}>
            <div className="nle-track-head">
              <span className="nle-track-id">
                <span className="nle-track-name" title={track.name}>{track.name}</span>
                {(track.kind === "audio" || track.kind === "video" || track.kind === "overlay") && <span ref={element => { if (element) trackMeters.current.set(track.id, element); else trackMeters.current.delete(track.id); }} role="meter" aria-label={`${track.name} 预览电平`} aria-valuemin={-60} aria-valuemax={0} aria-valuetext="未播放或电平不可用" title="实时预览轨道电平（dBFS）；未播放或音频不可用时不显示" className="nle-meter"><span aria-hidden="true" className="nle-meter-bar" /></span>}
              </span>
              <span className="nle-track-flags">
                <button type="button" aria-label={`${track.name} 静音`} aria-pressed={Boolean(track.muted)} title={track.muted ? "取消静音" : "静音"} className="nle-flag" onClick={() => toggleTrack(track.id, "muted")}>M</button>
                <button type="button" aria-label={`${track.name} 独听`} aria-pressed={Boolean(track.solo)} title="独听：任一轨道开启后，只有开启独听的轨道出声" className="nle-flag" onClick={() => toggleTrack(track.id, "solo")}>S</button>
                <button type="button" aria-label={`${track.name} 锁定`} aria-pressed={Boolean(track.locked)} title={track.locked ? "解锁轨道" : "锁定轨道"} className="nle-flag" onClick={() => toggleTrack(track.id, "locked")}>L</button>
                <button type="button" aria-label={`删除 ${track.name}`} title="删除轨道（Ctrl+Z 可撤销）" className="nle-flag nle-flag--remove" onClick={() => removeTrack(track.id)}>×</button>
              </span>
            </div>
            <div className="nle-lane" onPointerDown={event => { if (event.button !== 0) return; const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / pxPerMs); }}>
              {track.clips.map(clip => {
                const selected = selectedIds.has(clip.id);
                const incoming = nleTransitionProgress(clip, 0, "in") !== null;
                return <div key={clip.id} role="button" tabIndex={0} aria-label={`${track.name} ${clip.id}`} aria-pressed={selected} className="nle-clip" data-kind={clip.kind} data-selected={selected || undefined} style={{ left: clip.startMs * pxPerMs, width: Math.max(12, clip.durationMs * pxPerMs) }}
                  onPointerDown={event => onPointerDown(event, track.id, clip)} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => seek(clip.startMs)}>
                  {clip.kind === "audio" && <ClipWaveform src={applicationUrl(audioAssets.get(clip.id) ?? null)} />}
                  {(clip.kind === "image" || clip.kind === "video") && <NleClipThumbnail src={applicationUrl(`/api/media/assets/${clip.src.slice("assets/".length)}`)} kind={clip.kind} trimStartMs={clip.trimStartMs} durationMs={clip.durationMs} speed={clip.speed} speedCurve={clip.speedCurve} speedRamp={clip.speedRamp} widthPx={Math.max(12, clip.durationMs * pxPerMs)} />}
                  <span className="nle-clip-label">{clip.kind === "text" ? clip.text : clip.kind === "audio" ? "音频" : clip.kind}{incoming ? " ▸" : ""}{clip.speed && clip.speed !== 1 ? ` ${clip.speed}×` : ""}</span>
                  <span aria-label="左侧修剪" className="nle-clip-trim nle-clip-trim--start" onPointerDown={event => onPointerDown(event, track.id, clip, "start")} onPointerMove={onPointerMove} onPointerUp={endDrag} />
                  <span aria-label="右侧修剪" className="nle-clip-trim nle-clip-trim--end" onPointerDown={event => onPointerDown(event, track.id, clip, "end")} onPointerMove={onPointerMove} onPointerUp={endDrag} />
                  {/* Keyframe diamonds: click one to seek to its frame. */}
                  {(clip.keyframes ?? []).map(frame => <button key={frame.ms} type="button" aria-label={`关键帧 ${frame.ms}ms`} title={`关键帧 ${frame.ms}ms（点击定位）`} className="nle-key"
                    onClick={event => { event.stopPropagation(); seek(clip.startMs + frame.ms); }}
                    style={{ left: Math.max(0, Math.min(clip.durationMs * pxPerMs - 8, frame.ms * pxPerMs - 3)) }}
                    onPointerDown={event => event.stopPropagation()} />)}
                </div>;
              })}
            </div>
          </div>)}
          {band && <div aria-hidden data-band className="nle-band" style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }} />}
          </div>
          <div aria-hidden="true" className="nle-playhead" style={{ left: GUTTER + playhead * pxPerMs }} />
          {snapGuide !== null && <div aria-hidden data-snap-guide className="nle-snap" style={{ left: GUTTER + snapGuide * pxPerMs }}>
            <span className="nle-snap-label g-num">对齐 {Math.round(snapGuide)}ms</span>
          </div>}
        </div>
      </div>
    </div>
    </TimelineDock>
    {shortcutsOpen && <div role="dialog" aria-label="快捷键" className="nle-sheet" onClick={() => setShortcutsOpen(false)}>
      <div className="nle-sheet-panel" onClick={event => event.stopPropagation()}>
        <div className="nle-sheet-head">
          <span className="g-label">快捷键</span>
          <small>Esc 或 ? 关闭</small>
        </div>
        <dl className="nle-sheet-list">{SHORTCUTS.map(([keys, action]) => <div key={keys}>
          <dt><kbd>{keys}</kbd></dt>
          <dd>{action}</dd>
        </div>)}</dl>
      </div>
    </div>}
  </section></>;
}
