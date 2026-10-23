import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { buildTimeline, editTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { canDeleteScene, canMoveScene, changeNarration, downloadJson, downloadText, duplicateScene, moveScene, reorderScenes } from "./editor-model";
import { PreviewBoundary } from "./PreviewBoundary";
import { ShotCanvas } from "./ShotCanvas";
import { TimelinePanel } from "./TimelinePanel";
import { EffectsPanel } from "./EffectsPanel";
import { EditorAssistant } from "./EditorAssistant";
import { PanelBoundary } from "./PanelBoundary";
import { adoptLibraryVisual } from "./media-adoption";
const SaveCreationPack = lazy(() => import("./SaveCreationPack").then(module => ({ default: module.SaveCreationPack })));
const MediaCandidates = lazy(() => import("./MediaCandidates").then(module => ({ default: module.MediaCandidates })));
const SceneGenerator = lazy(() => import("./SceneGenerator").then(module => ({ default: module.SceneGenerator })));
const StylePackPicker = lazy(() => import("./StylePackPicker").then(module => ({ default: module.StylePackPicker })));
const CraftQuality = lazy(() => import("./CraftQuality").then(module => ({ default: module.CraftQuality })));
const VoiceWaveform = lazy(() => import("./VoiceWaveform").then(module => ({ default: module.VoiceWaveform })));

const Preview = lazy(() => import("./ProjectPreview"));
const SceneBoard = lazy(() => import("./SceneBoard").then(module => ({ default: module.SceneBoard })));
const button = { background: "#1c1c21", border: "1px solid #2b2b31", color: "#e4e4e7", padding: "7px 11px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13 };
const field = { width: "100%", minWidth: 0, padding: 9, borderRadius: 8, border: "1px solid #2b2b31", color: "#f4f4f5", background: "#151518", font: "inherit", fontSize: 13 };
const names: Record<string, string> = { title: "标题", subtitle: "副标题", heading: "小标题", text: "正文", term: "术语", definition: "释义", attribution: "出处", caption: "说明", label: "标签", note: "补充", code: "代码", language: "语言", items: "要点", points: "条目", left: "左侧", right: "右侧", steps: "步骤", data: "图表数据", value: "数值", unit: "单位" };

function editable(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; text: string | number }[] {
  if (typeof value === "string" || typeof value === "number") return [{ path, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([key]) => !["id", "kind", "narration", "src", "chartType", "effects", "tracks", "elements"].includes(key)).flatMap(([key, child]) => editable(child, [...path, Array.isArray(value) ? Number(key) : key]));
}

export function SceneEditor({ project, onChange, voiceEngine = "mock", history, selection, onSelect }: { project: SceneScriptProject; onChange(project: SceneScriptProject): void; voiceEngine?: string;
  history?: { undoDepth: number; redoDepth: number; undo(): void; redo(): void }; selection?: string[]; onSelect?(handle: string): void;
}) {
  const [selected, setSelected] = useState(0);
  const [past, setPast] = useState<SceneScriptProject[]>([]);
  const [future, setFuture] = useState<SceneScriptProject[]>([]);
  const [preview, setPreview] = useState(true);
  const [tab, setTab] = useState<"content" | "visual" | "audio" | "generate" | "assistant">("content");
  const [originalView, setOriginalView] = useState(false);
  const [boardView, setBoardView] = useState(false);
  const [boardNotice, setBoardNotice] = useState("");
  const [srtStatus, setSrtStatus] = useState("");
  const [orderNotice, setOrderNotice] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceAudio, setVoiceAudio] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);

  const selectedHandle = selection?.[0];
  const sharedIndex = selectedHandle ? project.scenes.findIndex(scene => scene.id === selectedHandle) : -1;
  const index = sharedIndex >= 0 ? sharedIndex : Math.min(selected, project.scenes.length - 1);
  const scene = project.scenes[index]!;
  const playhead = useRef<number | undefined>(undefined);
  useEffect(() => {
    setVoiceAudio(null); setVoiceError("");
    return () => previewRequest.current?.abort();
  }, [scene.id, scene.narration.text, scene.narration.voice, scene.narration.speakingRate, voiceEngine]);
  useEffect(() => () => { if (voiceAudio) URL.revokeObjectURL(voiceAudio); }, [voiceAudio]);
  const timeline = buildTimeline(project);
  const fps = project.fps ?? 30;
  const posterFrame = Math.min(15, Math.max(0, Math.round(((timeline.entries[index]?.durationMs ?? 0) / 1000) * fps) - 1));
  // Local history is also kept while the shared session is connected: if saving fails, the draft
  // must remain undoable instead of freezing the last keystrokes behind an unavailable server.
  const commit = (next: SceneScriptProject) => { setPast(items => [...items, project].slice(-30)); setFuture([]); onChange(next); };
  const undo = () => {
    if (history && history.undoDepth > 0) { setPast([]); setFuture([]); history.undo(); return; }
    const previous = past.at(-1); if (previous) { setFuture(items => [project, ...items]); setPast(items => items.slice(0, -1)); onChange(previous); }
  };
  const redo = () => {
    if (history && history.redoDepth > 0) { setPast([]); setFuture([]); history.redo(); return; }
    const next = future[0]; if (next) { setPast(items => [...items, project]); setFuture(items => items.slice(1)); onChange(next); }
  };
  const canUndo = Boolean(history && history.undoDepth > 0) || past.length > 0;
  const canRedo = Boolean(history && history.redoDepth > 0) || future.length > 0;
  type EditorVersion = { id: string; name: string; at: string; project: SceneScriptProject };
  const versionKey = `glint.editor.versions:${project.id}`;
  const readVersions = (): EditorVersion[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(versionKey) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.flatMap(item => {
        if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.at !== "string") return [];
        try { return [{ id: item.id, name: item.name, at: item.at, project: parseProject(item.project) }]; } catch { return []; }
      }).slice(0, 20);
    } catch { return []; }
  };
  const [versions, setVersions] = useState<EditorVersion[]>(readVersions);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState("");
  const [nleResult, setNleResult] = useState<{ format: "fcpxml" | "edl"; file: string; url: string; cuts: number; master: { file: string; url: string; bytes: number } } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch("/api/project/thumbnails", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }), signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(data => { if (!controller.signal.aborted && data && typeof data.thumbnails === "object") setThumbs(data.thumbnails); })
        .catch(() => { /* fallback to type tiles */ });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [project]);
  useEffect(() => { setVersions(readVersions()); }, [project.id]);
  const saveVersion = () => {
    const next = [{ id: crypto.randomUUID(), name: `版本 ${versions.length + 1}`, at: new Date().toISOString(), project }, ...versions].slice(0, 20);
    try { localStorage.setItem(versionKey, JSON.stringify(next)); setVersions(next); setOrderNotice("已保存命名版本。"); }
    catch { setOrderNotice("本机存储不足，版本未保存。"); }
  };
  const restoreVersion = (version: EditorVersion) => {
    try { commit(parseProject(version.project)); setOrderNotice(`已恢复「${version.name}」，可撤销。`); }
    catch { setOrderNotice("版本无法恢复，请重新保存。"); }
  };
  const exportProjectFile = async (format: "gif" | "png") => {
    if (exporting) return;
    setExporting(format); setOrderNotice("");
    try {
      const frame = format === "png" ? Math.round(((timeline.entries[index]?.durationMs ?? 0) / 1000) * fps * 0.35) : 0;
      const response = await fetch("/api/project/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, format, frame }), signal: AbortSignal.timeout(200_000) });
      const data = await response.json();
      if (!response.ok || typeof data?.url !== "string") throw new Error(typeof data?.error === "string" ? data.error : "导出失败");
      const link = document.createElement("a"); link.href = data.url; link.download = typeof data.file === "string" ? data.file : `${project.id}.${format}`; link.click();
      setOrderNotice(`已导出 ${format.toUpperCase()} · ${Math.round(Number(data.bytes) / 1024)} KB`);
    } catch (error) { setOrderNotice(error instanceof Error ? error.message : "导出失败"); }
    finally { setExporting(""); }
  };
  const exportNle = async (format: "fcpxml" | "edl") => {
    if (exporting) return;
    setExporting(format); setOrderNotice(""); setNleResult(null);
    try {
      const response = await fetch("/api/project/nle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, format }), signal: AbortSignal.timeout(260_000) });
      const data = await response.json();
      if (!response.ok || typeof data?.url !== "string" || typeof data?.master?.url !== "string") throw new Error(typeof data?.error === "string" ? data.error : "剪辑时间线导出失败");
      setNleResult({ format, file: data.file, url: data.url, cuts: Number(data.cuts) || 0, master: { file: data.master.file, url: data.master.url, bytes: Number(data.master.bytes) || 0 } });
      setOrderNotice(`已生成 ${format === "fcpxml" ? "FCPXML" : "EDL"} · ${data.cuts} 个切点；母版 MP4 在下方下载。`);
    } catch (error) { setOrderNotice(error instanceof Error ? error.message : "剪辑时间线导出失败"); }
    finally { setExporting(""); }
  };
  const addScene = () => {
    const id = `scene-${crypto.randomUUID().slice(0, 6)}`;
    commit({ ...project, scenes: [...project.scenes, { id, kind: "title", title: "新镜头", narration: { text: "新镜头旁白" } }] });
    setSelected(project.scenes.length);
  };
  const selectScene = (id: string) => {
    const position = project.scenes.findIndex(item => item.id === id);
    if (position >= 0) setSelected(position);
    onSelect?.(id);
  };
  const thumb = (item: (typeof project.scenes)[number]) => {
    const match = /^assets\/([a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4))$/.exec(item.kind === "image" || item.kind === "video" ? item.src : "");
    if (!match) return null;
    const src = `/api/media/assets/${match[1]}`;
    return item.kind === "video"
      ? <video key={src} aria-hidden muted preload="metadata" src={src} style={{ width: "100%", height: 48, objectFit: "cover", borderRadius: 8, display: "block" }} />
      : <img key={src} alt="" src={src} style={{ width: "100%", height: 48, objectFit: "cover", borderRadius: 8, display: "block" }} />;
  };
  return <div className="glint-editor" aria-label="分镜编辑器" onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement).tagName)) return;
    if (event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  }}>
    <style>{`
      .glint-editor { display: grid; gap: 10px; min-width: 0; color: #e4e4e7; font-size: 13px; --accent: #7c8cff; --surface-1: #151518; --surface-2: #1c1c21; --line: #2b2b31; --text: #e4e4e7; }
      .glint-editor-top { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid #26262b; border-radius: 12px; background: #101013; }
      .glint-editor-workspace { display: grid; grid-template-columns: 232px minmax(0, 1fr) 336px; gap: 10px; align-items: start; }
      .glint-editor-rail, .glint-editor-stage, .glint-editor-inspector, .glint-editor-timeline { border: 1px solid #26262b; border-radius: 12px; background: #0d0d10; min-width: 0; }
      .glint-editor-rail { padding: 10px; display: grid; gap: 8px; max-height: 760px; overflow: auto; }
      .glint-rail-head { display: flex; align-items: center; gap: 8px; }
      .glint-rail-head strong { font-size: 13px; }
      .glint-rail-head span { color: #8b8b95; font-size: 11px; }
      .glint-rail-head button { margin-left: auto; }
      .glint-rail-list { display: grid; gap: 6px; }
      .glint-rail-item { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; align-items: center; text-align: left; padding: 6px; border: 1px solid #26262b; border-radius: 10px; background: #151518; color: #e4e4e7; font: inherit; cursor: grab; }
      .glint-rail-item[aria-selected="true"] { border-color: #7c8cff; background: #1a1b24; }
      .glint-rail-thumb { height: 48px; border-radius: 8px; overflow: hidden; background: #0a0a0c; display: grid; place-items: center; border: 1px solid #232328; }
      .glint-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #8b8b95; }
      .glint-rail-meta { display: grid; gap: 2px; min-width: 0; }
      .glint-rail-meta strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .glint-rail-meta small { font-size: 10px; color: #8b8b95; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .glint-editor-stage { padding: 10px; display: grid; gap: 8px; }
      .glint-stage-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .glint-stage-head [role="group"] { display: flex; gap: 2px; padding: 3px; border: 1px solid #26262b; border-radius: 999px; background: #151518; }
      .glint-stage-head [role="group"] button { border: 0; background: transparent; color: #8b8b95; border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
      .glint-stage-head [role="group"] button[aria-pressed="true"] { background: #2a2a31; color: #f4f4f5; }
      .glint-stage-body { display: grid; gap: 8px; min-height: 360px; align-content: start; }
      .glint-board-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-height: 360px; }
      .glint-pip { position: absolute; right: 10px; bottom: 10px; z-index: 5; width: min(46%, 280px); border-radius: 10px; overflow: hidden; border: 1px solid #2b2b31; background: #0d0d10; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
      .glint-stage-empty { display: grid; place-items: center; gap: 10px; min-height: 320px; border: 1px dashed #2b2b31; border-radius: 10px; color: #8b8b95; font-size: 13px; text-align: center; }
      .glint-editor-inspector { padding: 10px; display: grid; gap: 10px; max-height: 760px; overflow: auto; }
      .glint-inspector-head { display: grid; gap: 6px; }
      .glint-inspector-head > div:first-child { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .glint-inspector-head strong { font-size: 13px; }
      .glint-inspector-head small { color: #8b8b95; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .glint-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid #26262b; padding-bottom: 6px; }
      .glint-tabs button { border: 1px solid transparent; background: transparent; color: #8b8b95; border-radius: 7px; padding: 5px 8px; font: inherit; font-size: 12px; cursor: pointer; }
      .glint-tabs button[aria-selected="true"] { border-color: #2b2b31; background: #1c1c21; color: #f4f4f5; }
      .glint-panel { display: grid; gap: 10px; min-width: 0; }
      .glint-editor-timeline { padding: 8px; position: sticky; bottom: 0; z-index: 8; background: #0d0d10; box-shadow: 0 -18px 40px rgba(0,0,0,.35); }
      .glint-editor-foot { color: #8b8b95; font-size: 11px; line-height: 1.6; }
      .glint-versions summary { cursor: pointer; color: #a1a1aa; font-size: 12px; }
      .glint-versions-list { display: grid; gap: 5px; max-height: 220px; overflow: auto; padding-top: 6px; }
      .glint-versions-list button { text-align: left; }
      @media (max-width: 1100px) { .glint-editor-workspace { grid-template-columns: 170px minmax(0, 1fr); } .glint-editor-inspector { grid-column: 1 / -1; max-height: none; } }
      @media (max-width: 760px) { .glint-editor-workspace { grid-template-columns: 1fr; } .glint-editor-stage { order: -1; } .glint-editor-rail { max-height: none; } .glint-board-grid { grid-template-columns: 1fr; } .glint-pip { position: relative; right: auto; bottom: auto; width: 100%; z-index: auto; margin-top: 8px; } }
    `}</style>

    <header className="glint-editor-top">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{project.scenes.length} 个分镜 · {(timeline.totalMs / 1000).toFixed(1)} 秒</strong>
        <span style={{ color: "#8b8b95", fontSize: 12 }}>第 {index + 1} 镜 · {scene.id}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={button} disabled={!canUndo} onClick={undo}>撤销</button>
          <button type="button" style={button} disabled={!canRedo} onClick={redo}>重做</button>
          <button type="button" style={button} onClick={saveVersion}>保存版本</button>
          <details className="glint-versions" style={{ position: "relative" }}>
            <summary style={{ padding: "7px 11px", border: "1px solid #2b2b31", borderRadius: 8 }}>版本 {versions.length}</summary>
            <div className="glint-versions-list" style={{ position: "absolute", right: 0, zIndex: 20, minWidth: 220, padding: 8, border: "1px solid #2b2b31", borderRadius: 10, background: "#151518", boxShadow: "0 18px 50px rgba(0,0,0,.5)" }}>
              {versions.length === 0 ? <small style={{ color: "#8b8b95" }}>还没有命名版本。</small> : versions.map(version => <button key={version.id} type="button" style={button} onClick={() => restoreVersion(version)}>{version.name}<small style={{ display: "block", color: "#8b8b95" }}>{new Date(version.at).toLocaleString()}</small></button>)}
            </div>
          </details>
          <details className="glint-versions" style={{ position: "relative" }}>
            <summary style={{ padding: "7px 11px", border: "1px solid #2b2b31", borderRadius: 8 }}>{exporting ? "导出中…" : "导出"}</summary>
            <div className="glint-versions-list" style={{ position: "absolute", right: 0, zIndex: 20, minWidth: 230, padding: 8, border: "1px solid #2b2b31", borderRadius: 10, background: "#151518", boxShadow: "0 18px 50px rgba(0,0,0,.5)" }}>
              <button type="button" style={button} disabled={Boolean(exporting)} onClick={() => void exportProjectFile("gif")}>{exporting === "gif" ? "正在渲染 GIF…" : "GIF · 前段 50%"}</button>
              <button type="button" style={button} disabled={Boolean(exporting)} onClick={() => void exportProjectFile("png")}>{exporting === "png" ? "正在渲染 PNG…" : "当前镜 PNG"}</button>
              <button type="button" style={button} disabled={Boolean(exporting)} onClick={() => void exportNle("fcpxml")}>{exporting === "fcpxml" ? "正在渲染母版…" : "FCPXML · 剪出镜头"}</button>
              <button type="button" style={button} disabled={Boolean(exporting)} onClick={() => void exportNle("edl")}>{exporting === "edl" ? "正在渲染母版…" : "EDL · 通用剪辑表"}</button>
              <small style={{ color: "#8b8b95", fontSize: 11, lineHeight: 1.55 }}>FCPXML/EDL 会先渲染母版 MP4，按镜头切点导出；未在 FCP/Premiere/Resolve 真机验证。GIF 只出前段、半尺寸。</small>
              {nleResult && <div style={{ display: "grid", gap: 5, paddingTop: 6, borderTop: "1px solid #2b2b31" }}>
                <a href={nleResult.url} download={nleResult.file} style={{ color: "#d4d4d8", fontSize: 12 }}>下载 {nleResult.format === "fcpxml" ? "FCPXML" : "EDL"}（{nleResult.cuts} 切点）</a>
                <a href={nleResult.master.url} download={nleResult.master.file} style={{ color: "#d4d4d8", fontSize: 12 }}>下载母版 MP4（{Math.round(nleResult.master.bytes / 1024)} KB）</a>
                <small style={{ color: "#8b8b95", fontSize: 11 }}>把两个文件放在同一台机器上再导入；母版路径已写进时间线。</small>
              </div>}
            </div>
          </details>
          <button type="button" style={button} onClick={() => downloadJson(`${project.id}.scenescript.json`, project)}>导出项目 JSON</button>
          <button type="button" style={button} onClick={async () => {
            try {
              const response = await fetch("/api/project/srt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }), signal: AbortSignal.timeout(20_000) });
              if (!response.ok) throw new Error("字幕导出失败，请检查工程后重试。");
              const data = await response.json();
              if (typeof data?.srt !== "string" || !data.srt.trim()) throw new Error("字幕为空：请先填写旁白。");
              downloadText(typeof data.name === "string" ? data.name : `${project.id}.srt`, data.srt);
              setSrtStatus("已导出字幕 SRT。");
            } catch (error) { setSrtStatus(error instanceof Error ? error.message : "字幕导出失败。"); }
          }}>导出字幕 SRT</button>
        </div>
      </div>
      {(srtStatus || orderNotice || boardNotice) && <div style={{ display: "flex", gap: 14, flexWrap: "wrap", color: "#8b8b95", fontSize: 12 }}>
        {srtStatus && <span role="status">{srtStatus}</span>}
        {orderNotice && <span role="status">{orderNotice}</span>}
        {boardNotice && <span role="status">{boardNotice}</span>}
      </div>}
    </header>

    <div className="glint-editor-workspace">
      <aside className="glint-editor-rail" aria-label="镜头栏">
        <div className="glint-rail-head"><strong>镜头</strong><span>{project.scenes.length}</span><button type="button" style={button} aria-label="添加镜头" onClick={addScene}>+ 新镜头</button></div>
        <div role="tablist" aria-label="分镜时间线" className="glint-rail-list">
          {project.scenes.map((item, position) => <button key={item.id} role="tab" aria-selected={index === position} draggable
            onClick={() => { setSelected(position); onSelect?.(item.id); }}
            onDragStart={event => { setDragIndex(position); event.dataTransfer?.setData("text/plain", String(position)); }}
            onDragOver={event => { event.preventDefault(); }}
            onDrop={event => {
              event.preventDefault();
              const from = dragIndex ?? Number(event.dataTransfer?.getData("text/plain"));
              setDragIndex(null);
              if (!Number.isInteger(from) || from === position) return;
              try { commit(reorderScenes(project, from, position)); setSelected(position); setOrderNotice("已按拖拽顺序排列，可撤销。"); }
              catch (error) { setOrderNotice(error instanceof Error ? error.message : "排序未生效。"); }
            }}
            onDragEnd={() => setDragIndex(null)}
            className="glint-rail-item">
            <span className="glint-rail-thumb">{thumb(item) ?? (thumbs[item.id] ? <img src={thumbs[item.id]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <span className="glint-kind">{item.kind}</span>)}</span>
            <span className="glint-rail-meta"><strong>{String(position + 1).padStart(2, "0")} · {item.kind}</strong><small>{(timeline.entries[position]!.durationMs / 1000).toFixed(1)}s · {item.id}</small></span>
          </button>)}
        </div>
        <small style={{ color: "#8b8b95" }}>拖动排序；画布位置不改变播放顺序。</small>
      </aside>

      <section className="glint-editor-stage" aria-label="舞台">
        <div className="glint-stage-head">
          <div role="group" aria-label="工作区视图">
            <button type="button" aria-pressed={!boardView} onClick={() => setBoardView(false)}>作品</button>
            <button type="button" aria-pressed={boardView} onClick={() => setBoardView(true)}>创意</button>
          </div>
          <span style={{ color: "#8b8b95", fontSize: 12 }}>{scene.kind} · 第 {index + 1} 镜</span>
          <button type="button" style={{ ...button, marginLeft: "auto" }} onClick={() => setPreview(value => !value)}>{preview ? "收起预览" : "播放预览"}</button>
        </div>
        {boardView
          ? <div aria-label="创意工作区" style={{ position: "relative", minWidth: 0 }}>
            <PreviewBoundary><Suspense fallback={<p role="status" style={{ padding: 12 }}>正在打开创意视图…</p>}>
              <SceneBoard project={project} selectedSceneId={scene.id} onSelect={selectScene} onAdopt={(name, mode) => {
                try {
                  const next = adoptLibraryVisual(project, scene.id, name, mode);
                  commit(next);
                  if (mode === "insert") {
                    const known = new Set(project.scenes.map(item => item.id));
                    const added = next.scenes.find(item => !known.has(item.id));
                    if (added) { setSelected(next.scenes.findIndex(item => item.id === added.id)); onSelect?.(added.id); }
                  }
                  setBoardNotice(mode === "replace" ? `已用「${name}」替换当前镜头素材，可撤销。` : `已将「${name}」添加为新镜头，可撤销。`);
                } catch (error) { setBoardNotice(error instanceof Error ? error.message : "素材未采用，原工程保留。"); }
              }} />
            </Suspense></PreviewBoundary>
            {preview ? <div aria-label="画布预览" className="glint-pip"><PreviewBoundary><Suspense fallback={<p role="status" style={{ margin: 0, padding: 8, fontSize: 11 }}>加载播放器…</p>}><Preview project={project} selectedSceneId={scene.id} initialFrame={playhead.current ?? posterFrame} onFrameChange={frame => { playhead.current = frame; }} /></Suspense></PreviewBoundary></div>
              : null}
          </div>
          : <div aria-label="作品工作区" className="glint-stage-body">
            {preview ? <>
              <label style={{ display: "flex", alignItems: "center", gap: 7, color: "#8b8b95", fontSize: 12 }}><input type="checkbox" checked={originalView} onChange={event => setOriginalView(event.target.checked)} />对比原画面（仅预览）</label>
              <PreviewBoundary><Suspense fallback={<p role="status" style={{ padding: 12 }}>加载播放器…</p>}>
                <Preview project={originalView ? { ...project, scenes: project.scenes.map(item => ({ ...item, effects: [] })) } : project}
                  selectedSceneId={scene.id} initialFrame={playhead.current ?? posterFrame} onFrameChange={frame => { playhead.current = frame; }} />
              </Suspense></PreviewBoundary>
            </> : <div className="glint-stage-empty"><p style={{ margin: 0 }}>选中的镜头会在这里播放。</p><button type="button" style={button} onClick={() => setPreview(true)}>播放预览</button></div>}
          </div>}
      </section>

      <aside className="glint-editor-inspector" aria-label="镜头属性">
        <div className="glint-inspector-head">
          <div><strong>第 {index + 1} 镜</strong><small>{scene.id}</small></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            <button type="button" style={button} disabled={!canMoveScene(project, index, -1)} onClick={() => { commit(moveScene(project, index, -1)); setSelected(index - 1); }}>上移</button>
            <button type="button" style={button} disabled={!canMoveScene(project, index, 1)} onClick={() => { commit(moveScene(project, index, 1)); setSelected(index + 1); }}>下移</button>
            <button type="button" style={button} disabled={!canDeleteScene(project, scene.id)} onClick={() => commit(editTimeline(project, { type: "ripple-delete", sceneId: scene.id }))}>删除分镜</button>
            <button type="button" style={button} disabled={scene.locked || project.scenes.length >= 30} onClick={() => {
              try { const next = duplicateScene(project, index, `copy-${crypto.randomUUID().slice(0, 8)}`); commit(next); setSelected(index + 1); setOrderNotice("已复制当前镜头，可撤销。"); }
              catch (error) { setOrderNotice(error instanceof Error ? error.message : "复制失败。"); }
            }}>复制分镜</button>
          </div>
        </div>
        <div role="tablist" aria-label="属性面板" className="glint-tabs">
          {([["content", "内容"], ["visual", "画面"], ["audio", "声音"], ["generate", "生成"], ["assistant", "改稿"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
          <button type="button" aria-label="查看剧本质量问题" onClick={() => setTab("assistant")} title="剧本结构检查，不检查成片像素" style={{ marginLeft: "auto", color: "#a1a1aa" }}>质量检查</button>
        </div>

        <div className="glint-panel" style={{ display: tab === "content" ? "grid" : "none" }}>
          {scene.kind === "chart" && <label>图表类型<select style={field} value={scene.chartType} onChange={event => { const next = structuredClone(project); const target = next.scenes[index]; if (target?.kind === "chart") target.chartType = event.target.value as "bar" | "line"; commit(next); }}><option value="bar">柱状图</option><option value="line">折线图</option></select></label>}
          {editable(scene).map(({ path, text }) => <label key={path.join(".")}>{path.map(part => typeof part === "number" ? part + 1 : names[part] ?? part).join(" / ")}
            {typeof text === "number" ? <input aria-label={path.join(".")} type="number" style={field} value={text} onChange={event => {
              if (!event.target.value || !Number.isFinite(Number(event.target.value))) return;
              const next = structuredClone(project); let cursor: any = next.scenes[index];
              for (const part of path.slice(0, -1)) cursor = cursor[part];
              cursor[path.at(-1)!] = Number(event.target.value); commit(next);
            }} /> : <textarea aria-label={path.join(".")} rows={text.length > 80 ? 4 : 2} style={field} value={text} onChange={event => {
              const next = structuredClone(project);
              let cursor: any = next.scenes[index];
              for (const part of path.slice(0, -1)) cursor = cursor[part];
              cursor[path.at(-1)!] = event.target.value || " "; commit(next);
            }} />}
          </label>)}
          <button type="button" style={button} onClick={() => {
            const id = `chart-${crypto.randomUUID().slice(0, 8)}`;
            commit({ ...project, scenes: [...project.scenes, { id, kind: "chart", chartType: "bar", heading: "示例数据 · 请替换", data: [{ label: "示例 A", value: 10 }, { label: "示例 B", value: 18 }], narration: { text: "这是一组示例数据，请在发布前替换。" } }] }); setSelected(project.scenes.length);
          }}>添加图表（示例数据）</button>
          <PanelBoundary label="创作包工具"><Suspense fallback={null}><SaveCreationPack project={project} /></Suspense></PanelBoundary>
        </div>

        <div className="glint-panel" style={{ display: tab === "visual" ? "grid" : "none" }}>
          <PanelBoundary label="风格工具"><Suspense fallback={<p role="status">正在加载风格与导出工具…</p>}><StylePackPicker project={project} onChange={commit} /></Suspense></PanelBoundary>
          <EffectsPanel project={project} sceneId={scene.id} onChange={commit} />
          <ShotCanvas project={project} scene={scene} onChange={nextScene => { const next = structuredClone(project); next.scenes[index] = nextScene; commit(next); }} />
        </div>

        <div className="glint-panel" style={{ display: tab === "audio" ? "grid" : "none" }}>
          <label>旁白 / 字幕<textarea aria-label="旁白" rows={4} style={field} value={scene.narration.text} onChange={event => commit(changeNarration(project, index, event.target.value))} /></label>
          <label>旁白偏移 · {scene.narration.audioOffsetMs ?? 0} ms<input aria-label="旁白偏移" type="range" min="-5000" max="5000" step="50" value={scene.narration.audioOffsetMs ?? 0} onChange={event => {
            const next = structuredClone(project); const offset = Number(event.target.value);
            next.scenes[index]!.narration.audioOffsetMs = offset === 0 ? undefined : offset; commit(next);
          }} /></label>
          <small style={{ color: "#8b8b95", lineHeight: 1.6 }}>负值让配音提前进入（J cut），正值延后（L cut）；范围 ±5 秒，只影响这一镜。</small>
          <label>音色 ID（留空使用引擎默认音色）<input aria-label="音色 ID" style={field} value={scene.narration.voice ?? ""} onChange={event => {
            const next = changeNarration(project, index, scene.narration.text);
            next.scenes[index]!.narration.voice = event.target.value || undefined; commit(next);
          }} /></label>
          <label>语速 · {scene.narration.speakingRate ?? 1}×<input aria-label="语速" type="range" min="0.5" max="2" step="0.05" value={scene.narration.speakingRate ?? 1} onChange={event => {
            const next = changeNarration(project, index, scene.narration.text);
            next.scenes[index]!.narration.speakingRate = Number(event.target.value); commit(next);
          }} /></label>
          <button type="button" style={button} disabled={previewing || voiceEngine === "mock"} onClick={async () => {
            setPreviewing(true); setVoiceError(""); setVoiceAudio(null);
            const controller = new AbortController(); previewRequest.current = controller;
            try {
              if (scene.narration.text.length > 300) throw new Error("试听最多 300 字，请先缩短该分镜。");
              const response = await fetch("/api/voice-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: voiceEngine, text: scene.narration.text, voice: scene.narration.voice, speakingRate: scene.narration.speakingRate }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
              if (!response.ok) throw new Error((await response.json()).error ?? "试听失败");
              const blob = await response.blob(); controller.signal.throwIfAborted();
              setVoiceAudio(URL.createObjectURL(blob));
            } catch (error) { if (!controller.signal.aborted) setVoiceError(error instanceof Error ? error.message : "试听失败"); }
            finally { setPreviewing(false); }
          }}>{previewing ? "生成试听中…" : "试听本分镜"}</button>
          {voiceAudio && <><audio aria-label="分镜配音试听" controls src={voiceAudio} /><Suspense fallback={null}><VoiceWaveform src={voiceAudio} /></Suspense></>}
          {voiceError && <p role="alert" style={{ margin: 0, color: "#fca5a5" }}>{voiceError}</p>}
          <fieldset style={{ display: "grid", gap: 8, margin: 0, padding: 10, border: "1px solid #2b2b31", borderRadius: 10 }}>
            <legend style={{ padding: "0 4px" }}>本镜音效</legend>
            {(project.sfx ?? []).map((cue, cueIndex) => ({ cue, cueIndex })).filter(({ cue }) => cue.sceneId === scene.id).map(({ cue, cueIndex }, position) => <div key={cueIndex} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto", gap: 6, alignItems: "center" }}>
              <select aria-label={`音效 ${position + 1}`} style={field} value={cue.effect} onChange={event => {
                const next = structuredClone(project); next.sfx![cueIndex] = { ...next.sfx![cueIndex]!, effect: event.target.value as NonNullable<SceneScriptProject["sfx"]>[number]["effect"] }; commit(next);
              }}>{(["impact", "whoosh", "sparkle", "click", "pop", "riser"] as const).map(effect => <option key={effect} value={effect}>{{ impact: "冲击", whoosh: "呼啸", sparkle: "闪光", click: "点击", pop: "弹出", riser: "上升" }[effect]}</option>)}</select>
              <label style={{ display: "grid", gap: 2, fontSize: 11 }}>音量 {Math.round((cue.gain ?? 0.35) * 100)}%<input aria-label={`音效 ${position + 1} 音量`} type="range" min="0" max="1" step="0.05" value={cue.gain ?? 0.35} onChange={event => {
                const next = structuredClone(project); next.sfx![cueIndex] = { ...next.sfx![cueIndex]!, gain: Number(event.target.value) }; commit(next);
              }} /></label>
              <button type="button" style={button} aria-label={`删除音效 ${position + 1}`} onClick={() => {
                const next = structuredClone(project); next.sfx = (next.sfx ?? []).filter((_, itemIndex) => itemIndex !== cueIndex); commit(next);
              }}>删除</button>
            </div>)}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" style={button} disabled={(project.sfx ?? []).filter(cue => cue.sceneId === scene.id).length >= 8} onClick={() => {
                const next = structuredClone(project); next.sfx = [...(next.sfx ?? []), { sceneId: scene.id, effect: "whoosh", gain: 0.35 }]; commit(next);
              }}>添加音效</button>
              <small style={{ color: "#8b8b95" }}>最多 8 个/镜；成片时叠加在旁白上。</small>
            </div>
          </fieldset>
          {project.music && <label>配乐音量 · {Math.round((project.music.volume ?? 0.12) * 100)}%<input aria-label="配乐音量" type="range" min="0" max="1" step="0.01" value={project.music.volume ?? 0.12} onChange={event => {
            const next = structuredClone(project); next.music = { ...next.music!, volume: Number(event.target.value) }; commit(next);
          }} /></label>}
          <small style={{ color: "#8b8b95", lineHeight: 1.6 }}>Qwen 克隆使用参考录音原速，不支持音色 ID 和变速；ElevenLabs / Fish 语速范围 0.7–1.2×。</small>
        </div>

        <div className="glint-panel" style={{ display: tab === "generate" ? "grid" : "none" }}>
          <PanelBoundary label="素材工具"><Suspense fallback={<p role="status">正在加载素材工具…</p>}><MediaCandidates project={project} sceneId={scene.id} onChange={next => { commit(next); if (next.scenes.length > project.scenes.length) setSelected(index + 1); }} onSelect={selectScene} /></Suspense></PanelBoundary>
          <PanelBoundary label="生成工具"><Suspense fallback={<p role="status">正在加载生成工具…</p>}><SceneGenerator project={project} sceneId={scene.id} onChange={next => { commit(next); if (next.scenes.length > project.scenes.length) setSelected(index + 1); }} onSelect={selectScene} /></Suspense></PanelBoundary>
        </div>

        <div className="glint-panel" style={{ display: tab === "assistant" ? "grid" : "none" }}>
          <PanelBoundary label="质量检查"><Suspense fallback={<p role="status" style={{ margin: 0, color: "#8b8b95", fontSize: 12 }}>正在检查剧本结构…</p>}><CraftQuality project={project} onSelectScene={selectScene} /></Suspense></PanelBoundary>
          <EditorAssistant project={project} sceneId={scene.id} onChange={commit} />
        </div>
      </aside>
    </div>

    <div className="glint-editor-timeline"><TimelinePanel project={project} selectedSceneId={scene.id} onChange={commit} onSelect={id => {
      const position = project.scenes.findIndex(item => item.id === id);
      if (position >= 0) setSelected(position);
      onSelect?.(id);
    }} /></div>
    <small className="glint-editor-foot">无声预览；字幕按文本估时。导出配音后时长以实际音频为准。{history ? "撤销与 Skill / CLI 共用工程历史。" : "撤销保留最近 30 次修改。"}</small>
  </div>;
}
