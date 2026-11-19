import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { buildTimeline, editTimeline, type SceneScriptProject } from "@glintai/scenescript";

const button: CSSProperties = { color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid currentColor", background: "transparent", color: "inherit", font: "inherit" };

/**
 * Reference video → reviewable project. Cuts and motion are inferred with local
 * FFmpeg analysis and reference frames are copied into the media library; the
 * user still replaces them with their own material before delivery.
 */
export type UploadReference = (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => Promise<{ name: string }>;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * CREATE-10 manual correction: the human overrides the inferred style proposal
 * (picked palette colors, per-shot seconds) and the result is written back into
 * the project — theme colors become inline token overrides, shot seconds become
 * narration durationMs that both renderers and the timeline honor.
 */
export interface ManualCorrection { background?: string; accent?: string; shotSeconds?: number }
/** Adjust one boundary without changing the combined duration of its two shots.
 *  With an overlap transition the target is the dissolve centre; the overlap
 *  itself and every later shot stay put because the two durations trade delta. */
export function moveReferenceBoundary(project: SceneScriptProject, sceneId: string, previousId: string, targetMs: number): SceneScriptProject {
  const index = project.scenes.findIndex(scene => scene.id === sceneId);
  if (index < 1 || project.scenes[index - 1]?.id !== previousId) throw new Error("相邻镜头已变化，请重新分析参考片。");
  const previous = project.scenes[index - 1]!, current = project.scenes[index]!;
  if (previous.locked || current.locked) throw new Error("相邻镜头已锁定，请先解锁。");
  if (!Number.isSafeInteger(targetMs)) throw new Error("请输入有效切点时间。");
  const timeline = buildTimeline(project), entry = timeline.entries[index]!, before = timeline.entries[index - 1]!;
  const overlap = Math.max(0, before.startMs + before.durationMs - entry.startMs);
  const delta = targetMs - (entry.startMs + overlap / 2);
  const left = before.durationMs + delta, right = entry.durationMs - delta;
  if (left < overlap + 200 || right < overlap + 200) throw new Error("调整后两侧镜头需保留完整转场且各有至少 0.2 秒非交叠画面。");
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error("转场中心位于半毫秒，请选择可保持整数毫秒镜长的时间。");
  const adjusted = { ...project, scenes: project.scenes.map((scene, position) => position === index - 1 ? { ...scene, narration: { ...scene.narration, durationMs: left } } : position === index ? { ...scene, narration: { ...scene.narration, durationMs: right } } : scene) };
  const updated = buildTimeline(adjusted);
  const oldOverlap = (position: number) => timeline.entries[position - 1]!.startMs + timeline.entries[position - 1]!.durationMs - timeline.entries[position]!.startMs;
  const newOverlap = (position: number) => updated.entries[position - 1]!.startMs + updated.entries[position - 1]!.durationMs - updated.entries[position]!.startMs;
  if ([index - 1, index, index + 1].some(position => position > 0 && position < timeline.entries.length && oldOverlap(position) !== newOverlap(position)) || updated.totalMs !== timeline.totalMs || updated.entries.slice(index + 1).some((entry, offset) => entry.startMs !== timeline.entries[index + 1 + offset]!.startMs)) throw new Error("调整会改变相邻转场或后续镜头时间，请先调整相关转场或镜长。");
  return adjusted;
}
export function splitReferenceAt(project: SceneScriptProject, targetMs: number, newSceneId: string): SceneScriptProject {
  if (!Number.isSafeInteger(targetMs)) throw new Error("请输入有效切点时间。");
  const timeline = buildTimeline(project);
  const entries = timeline.entries.filter(entry => targetMs > entry.startMs && targetMs < entry.startMs + entry.durationMs);
  if (entries.length !== 1) throw new Error("切点不在唯一镜头内部；交叠转场或已有切点需要手动调整。");
  const entry = entries[0]!;
  try { return editTimeline(project, { type: "split", sceneId: entry.scene.id, atMs: targetMs - entry.startMs, newSceneId, duplicateText: true }); }
  catch (cause) { throw new Error(`无法安全分割：${cause instanceof Error ? cause.message : "镜头不可分割"}。请检查锁定、动画、转场及音频。`); }
}

export function isOcrSampleCurrent(original: SceneScriptProject, current: SceneScriptProject | null, sceneId: string): boolean {
  if (!current || current.id !== original.id) return false;
  const before = buildTimeline(original).entries.find(entry => entry.scene.id === sceneId);
  const after = buildTimeline(current).entries.find(entry => entry.scene.id === sceneId);
  return !!before && !!after && before.startMs === after.startMs && before.durationMs === after.durationMs && before.scene.kind === "image" && after.scene.kind === "image" && before.scene.src === after.scene.src;
}
export function applyManualCorrection<T extends { theme?: unknown; scenes: Array<{ narration: { durationMs?: number }; [key: string]: unknown }> }>(project: T, correction: ManualCorrection): T {
  const background = correction.background && HEX.test(correction.background) ? correction.background : undefined;
  const accent = correction.accent && HEX.test(correction.accent) ? correction.accent : undefined;
  const base = typeof project.theme === "object" && project.theme !== null ? project.theme as Record<string, unknown> : {};
  const theme = background || accent
    ? { ...base, colors: { ...((base.colors as Record<string, unknown>) ?? {}), ...(background ? { bg: background } : {}), ...(accent ? { accent } : {}) } }
    : project.theme;
  return {
    ...project,
    theme,
    scenes: correction.shotSeconds && correction.shotSeconds > 0
      ? project.scenes.map(scene => ({ ...scene, narration: { ...scene.narration, durationMs: Math.round(correction.shotSeconds! * 1000) } }))
      : project.scenes,
  };
}
export function ReferenceBuilder({ onProject, currentProject, disabled = false, uploadFile = uploadReferenceVideo }: { onProject(project: unknown): boolean | void; currentProject: SceneScriptProject | null; disabled?: boolean; uploadFile?: UploadReference }) {
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState<{ name: string; url: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [useOcr, setUseOcr] = useState(false);
  const [ocrResult, setOcrResult] = useState<{ status: "complete" | "failed" | "unavailable"; sourceSha256?: string; samples: Array<{ sceneId: string; requestedMs: number; status: "recognized" | "no_text"; lines: Array<{ text: string; score: number }> }> } | null>(null);
  const [ocrDrafts, setOcrDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [style, setStyle] = useState<Array<{ hex: string; share: number }>>([]);
  const [boundaries, setBoundaries] = useState<Array<{ sceneId: string; startMs: number; change: number | null }>>([]);
  const [boundaryDrafts, setBoundaryDrafts] = useState<Record<string, string>>({});
  const [source, setSource] = useState<{ name: string; sha256: string; durationMs: number } | null>(null);
  const [referenceFrames, setReferenceFrames] = useState<Record<string, string>>({});
  const [cutLimits, setCutLimits] = useState<{ mergedCuts: number; omittedCuts: number; adaptiveCandidatesSkipped?: number; uncertainCuts?: Array<{ timeMs: number; reason: string }> } | null>(null);
  // CREATE-10: the last built project + inferred proposal stay available so the
  // human can correct them (colors, shot length) and write the result back.
  const [built, setBuilt] = useState<{ project: unknown; style: { palette: Array<{ hex: string; share: number }>; medianShotMs?: number } | null } | null>(null);
  const [correction, setCorrection] = useState<{ background: string; accent: string; shotSeconds: string }>({ background: "", accent: "", shotSeconds: "" });
  const builtId = built && typeof built.project === "object" && built.project !== null && "id" in built.project ? built.project.id : null;
  const canCorrectCurrent = Boolean(currentProject && typeof builtId === "string" && currentProject.id === builtId);
  const lockedDuration = Boolean(Number(correction.shotSeconds) > 0 && currentProject?.scenes.some(scene => scene.locked));
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewAt, setReviewAt] = useState<string>("");
  const [duplicateNarration, setDuplicateNarration] = useState(false);
  const [referenceTimeline, setReferenceTimeline] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reviewUrlRef = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const latestFile = useRef<File | null>(null);
  const latestProject = useRef(currentProject); latestProject.current = currentProject;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); controller.current = null; if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current); }; }, []);

  const loadLibrary = async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setError("");
    try {
      const response = await fetch("/api/media/library", { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (current.signal.aborted) return;
      const list = (Array.isArray(data.assets) ? data.assets : [])
        .filter((item: { name?: unknown }) => typeof item?.name === "string" && /^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(item.name))
        .map((item: { name: string }) => ({ name: item.name, url: `/api/media/assets/${item.name}` }));
      setVideos(list); setSelected(value => list.some((item: { name: string }) => item.name === value) ? value : latestFile.current ? "" : list[0]?.name ?? "");
    } catch { if (!current.signal.aborted) setError("无法读取素材库视频，请检查本地服务后重试。"); }
  };
  const build = async () => {
    if ((!selected && !file) || !consent || disabled || busy) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice(""); setOcrResult(null); setOcrDrafts({}); setSource(null); setReferenceFrames({}); setCutLimits(null); setReferenceTimeline(null); setReviewAt("");
    if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current); reviewUrlRef.current = null; setReviewUrl(null);
    try {
      let name = selected;
      if (file) {
        setNotice("正在上传参考片…"); setProgress(0);
        const uploadedBody = await uploadFile(file, percent => setProgress(percent), current.signal);
        if (!uploadedBody?.name) throw new Error("上传返回缺少文件名，请重试。");
        name = uploadedBody.name; setProgress(null);
        setVideos(value => value.some(item => item.name === name) ? value : [...value, { name, url: `/api/media/assets/${name}` }]);
        setSelected(name);
        setFile(null);
        latestFile.current = null;
        if (fileInput.current) fileInput.current.value = "";
        setNotice("上传完成，正在切镜与生成工程…");
      }
      const response = await fetch("/api/reference/build", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ...(useOcr ? { ocr: true } : {}) }), signal: AbortSignal.any([current.signal, AbortSignal.timeout(300_000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? "已有参考分析在运行，请稍后再试。" : data?.error ?? "参考分析失败，请换一段视频重试。");
      if (current.signal.aborted) return;
      if (!data?.project) throw new Error("分析完成但没有生成工程，请重试。");
      if (onProject(data.project) === false) throw new Error("工程载入失败，原工程未被替换。");
      const origin = data.source;
      if (origin && origin.name === name && typeof origin.sha256 === "string" && /^[a-f0-9]{64}$/.test(origin.sha256) && Number.isSafeInteger(origin.durationMs) && origin.durationMs > 0 && origin.durationMs <= 600_000) {
        setSource(origin);
        const scenes = Array.isArray(data.project.scenes) ? data.project.scenes : [];
        setReferenceFrames(Object.fromEntries(scenes.filter((scene: { kind?: unknown; id?: unknown; src?: unknown }) => scene.kind === "image" && typeof scene.id === "string" && typeof scene.src === "string").map((scene: { id: string; src: string }) => [scene.id, scene.src])));
      }
      const palette = Array.isArray(data.style?.palette) ? data.style.palette : [];
      setBoundaries(Array.isArray(data.boundaries) ? data.boundaries.filter((entry: { sceneId?: unknown; startMs?: unknown; change?: unknown }) => typeof entry.sceneId === "string" && typeof entry.startMs === "number" && (entry.change === null || typeof entry.change === "number")) : []);
      setBoundaryDrafts({});
      setCutLimits(data.limits ?? null);
      setStyle(palette);
      if (data.ocr && ["complete", "failed", "unavailable"].includes(data.ocr.status) && Array.isArray(data.ocr.samples)) setOcrResult(data.ocr);
      setBuilt({ project: data.project, style: data.style ?? null });
      setReferenceTimeline(JSON.stringify(buildTimeline(data.project as SceneScriptProject).entries.map(entry => [entry.scene.id, entry.startMs, entry.durationMs])));
      setCorrection({ background: "", accent: "", shotSeconds: "" });
      setNotice(`已生成 ${Number(data.shots) || 0} 镜的可编辑工程（推断）${data.style?.medianShotMs ? ` · 主镜头约 ${(data.style.medianShotMs / 1000).toFixed(1)}s` : ""}。参考帧只用于本地预览，交付前请替换成自己的素材。`);
      setStyle(palette);
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "参考分析失败，请重试。"); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };

  const openReview = async (timeMs: number) => {
    if (!source || disabled || busy || timeMs < 0 || timeMs >= source.durationMs) return;
    if (reviewUrlRef.current && videoRef.current) {
      videoRef.current.currentTime = timeMs / 1000; setReviewAt((timeMs / 1000).toFixed(3)); setNotice("已定位到原参考片疑似位置，请人工核对。"); return;
    }
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice("正在校验并加载原参考片…");
    try {
      const response = await fetch(`/api/media/assets/${encodeURIComponent(source.name)}`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(60_000)]), cache: "no-store" });
      if (!response.ok) throw new Error("无法读取原参考片，请重新分析。");
      const blob = await response.blob();
      if (blob.size < 1 || blob.size > 300 * 1024 * 1024) throw new Error("参考片大小无效，请重新分析。");
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      if (sha256 !== source.sha256) throw new Error("参考片已变化，请重新分析；未打开或修改工程。");
      if (current.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current);
      reviewUrlRef.current = url; setReviewUrl(url); setReviewAt((timeMs / 1000).toFixed(3)); setDuplicateNarration(false);
      setNotice("已校验原片，请在播放器中核对位置。设置切点前需确认旁白复制。");
    } catch (cause) { if (!current.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : "参考片读取失败，请重试。"); }
    finally { if (mounted.current) setBusy(false); }
  };

  const refreshFrames = async (sceneId: string, previousId: string) => {
    const snapshot = latestProject.current;
    if (!source || !snapshot || !canCorrectCurrent || busy || disabled) return;
    let current: AbortController | undefined;
    try {
      const index = snapshot.scenes.findIndex(scene => scene.id === sceneId);
      if (index < 1 || snapshot.scenes[index - 1]?.id !== previousId) throw new Error("镜头关系已变化，无法重抽参考帧。");
      const previous = snapshot.scenes[index - 1]!, next = snapshot.scenes[index]!;
      if (previous.locked || next.locked) throw new Error("相邻镜头已锁定，请先解锁。");
      if (previous.kind !== "image" || next.kind !== "image" || previous.src !== referenceFrames[previousId] || next.src !== referenceFrames[sceneId]) throw new Error("参考帧已被替换，未覆盖当前素材。");
      const timeline = buildTimeline(snapshot), left = timeline.entries[index - 1]!, right = timeline.entries[index]!;
      const times = [Math.floor(left.startMs + left.durationMs / 2), Math.floor(right.startMs + right.durationMs / 2)];
      if (times.some(ms => ms < 0 || ms >= source.durationMs)) throw new Error("当前镜头超出参考片时长，无法抽帧。");
      const before = JSON.stringify(snapshot); current = new AbortController(); controller.current = current;
      setBusy(true); setError(""); setNotice("正在从原参考片重抽相邻两镜的中点帧…");
      const response = await fetch("/api/reference/frames", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: source.name, sha256: source.sha256, times }), signal: AbortSignal.any([current.signal, AbortSignal.timeout(65_000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "参考帧抽取失败。");
      if (current.signal.aborted) return;
      if (!Array.isArray(data.names) || data.names.length !== 2 || data.names.some((name: unknown) => typeof name !== "string" || !/^ref-frame-[a-f0-9]{24}-[01]\.jpg$/.test(name)) || JSON.stringify(data.times) !== JSON.stringify(times)) throw new Error("参考帧响应无效。");
      if (JSON.stringify(latestProject.current) !== before) throw new Error("工程在抽帧期间发生变化，未覆盖当前工程；新素材已留在素材库。");
      const refs = [`assets/${data.names[0]}`, `assets/${data.names[1]}`];
      if (onProject({ ...snapshot, scenes: snapshot.scenes.map(scene => scene.id === previousId ? { ...scene, src: refs[0] } : scene.id === sceneId ? { ...scene, src: refs[1] } : scene) }) === false) throw new Error("工程保存失败，未回写参考帧；新素材已留在素材库。");
      setReferenceFrames(value => ({ ...value, [previousId]: refs[0]!, [sceneId]: refs[1]! }));
      setNotice("已按当前切点重抽相邻镜头的中点参考帧；原始亮度测量不变。");
    } catch (cause) { if (mounted.current && !current?.signal.aborted) setError(cause instanceof Error ? cause.message : "参考帧抽取失败。"); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <details aria-label="从参考片重建工程" onToggle={event => { if (event.currentTarget.open) { setOpen(true); if (!videos.length) void loadLibrary(); } }}>
    <summary style={{ cursor: "pointer" }}>参考片 → 可审阅工程（推断）</summary>
    <div style={{ display: "grid", gap: 10, paddingTop: 10, minWidth: 0 }}>
      <small>本地切镜并抽帧，生成每镜一张参考图的工程骨架；切点、时长与机位都是启发式推断，不还原原片图层、骨架或人物。参考帧会进入素材库，交付前请替换。</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>上传参考片（MP4，≤300 MB）<input ref={fileInput} aria-label="上传参考片" type="file" accept="video/mp4" disabled={busy} onChange={event => { const next = event.target.files?.[0] ?? null; latestFile.current = next; setFile(next); setError(""); if (next) setSelected(""); }} /></label>
        {file && <small>待上传：{file.name}{file.size ? ` · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ""}</small>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>或选素材库视频<select aria-label="选择参考片" style={{ ...field, minWidth: 180, width: "auto" }} value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); latestFile.current = null; setFile(null); if (fileInput.current) fileInput.current.value = ""; }}><option value="">请选择素材库视频</option>{videos.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <button type="button" style={button} disabled={busy} onClick={() => void loadLibrary()}>刷新列表</button>
      </div>
      {!videos.length && !error && <p role="status" style={{ margin: 0 }}>素材库里还没有 MP4。可以先用媒体工坊生成，或把参考片放进素材库。</p>}
      <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认有权使用这段参考片，并会在交付前替换其中的参考帧</label>
      <label><input type="checkbox" checked={useOcr} disabled={busy} onChange={event => setUseOcr(event.target.checked)} />本机识别各镜画面文字（可选，不上传、不写入旁白）</label>
      <button type="button" style={{ ...button, justifySelf: "start", opacity: !consent || (!selected && !file) || busy ? 0.5 : 1 }} disabled={!consent || (!selected && !file) || busy || disabled} onClick={() => void build()}>{busy ? "正在处理参考片…" : file ? "上传并生成工程" : "分析并生成工程"}</button>
      {open && busy && <small>分析可能需要十几秒；期间不要关闭页面。</small>}
      {progress !== null && <p role="status" style={{ margin: 0 }}>正在上传参考片… {progress}%</p>}
      {ocrResult && <details aria-label="参考画面文字识别">
        <summary>画面文字识别（估算）</summary>
        <small>每镜取接近原始推断镜头中点的一帧；时间为请求采样时间，非逐字时间码。模型评分不是校准准确率，结果不自动写入工程；镜头或素材变化后原结果不能代表当前镜头。人工核对后可写入画面说明，说明可能显示在成片中；草稿仅在当前页面保留。</small>
        {ocrResult.status === "unavailable" && <p>本机 OCR 尚未启用，镜头文字不会被识别。这不影响其他分析；启用方法见<a className="g-link" href="#/docs">使用文档</a>。</p>}
        {ocrResult.status === "failed" && <p>本机 OCR 未完成；参考工程仍可编辑。</p>}
        {ocrResult.status === "complete" && <ol>{ocrResult.samples.map(sample => {
          const valid = Boolean(built && isOcrSampleCurrent(built.project as SceneScriptProject, currentProject, sample.sceneId));
          const scene = currentProject?.scenes.find(item => item.id === sample.sceneId);
          const draft = ocrDrafts[sample.sceneId] ?? sample.lines.map(line => line.text).join("\n");
          const hasCaption = scene?.kind === "image" && Boolean(scene.caption?.trim());
          return <li key={sample.sceneId}>
            {sample.sceneId} · 原始请求采样 {(sample.requestedMs / 1000).toFixed(2)} 秒
            {!valid && <strong> · 已过期：当前镜头或素材与原分析不同，请重新分析核对</strong>}
            {sample.status === "no_text" ? <p>未识别到文字，不代表画面无文字。</p> : <ul>{sample.lines.map((line, index) => <li key={index}>{line.text} · 模型评分 {(line.score * 100).toFixed(0)}%</li>)}</ul>}
            <label>人工核对文字<textarea aria-label={`人工核对文字 ${sample.sceneId}`} style={{ ...field, display: "block", width: "100%", maxWidth: 500 }} maxLength={4000} value={draft} onChange={event => setOcrDrafts(value => ({ ...value, [sample.sceneId]: event.target.value }))} /></label>
            <button type="button" style={button} disabled={disabled || busy || !valid || scene?.kind !== "image" || scene.locked || hasCaption || !draft.trim()} onClick={() => {
              const snapshot = latestProject.current;
              const target = snapshot?.scenes.find(item => item.id === sample.sceneId);
              if (!built || !snapshot || !isOcrSampleCurrent(built.project as SceneScriptProject, snapshot, sample.sceneId) || target?.kind !== "image" || target.locked || target.caption?.trim() || !draft.trim()) return;
              if (onProject({ ...snapshot, scenes: snapshot.scenes.map(item => item.id === sample.sceneId && item.kind === "image" ? { ...item, caption: draft.trim() } : item) }) === false) { setError("工程保存失败，未写入画面说明。"); return; }
              setError(""); setNotice("已将人工核对文字写入该镜画面说明，未修改旁白。");
            }}>写入该镜画面说明</button>
            {hasCaption && <small>该镜已有画面说明；为避免覆盖，请在编辑器中修改。</small>}
            {scene?.locked && <small>该镜已锁定，请先解锁。</small>}
          </li>;
        })}</ol>}
      </details>}
      {style.length > 0 && <div aria-label="参考片配色" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <small>提取的主色（推断）</small>
        {style.map(entry => <span key={entry.hex} title={`${entry.hex} · ${Math.round(entry.share * 100)}%`} style={{ width: 26, height: 26, borderRadius: 6, background: entry.hex, border: "1px solid rgba(255,255,255,.25)" }} />)}
      </div>}
      {built && source && <button type="button" style={{ ...button, justifySelf: "start" }} disabled={disabled || busy} onClick={() => void openReview(0)}>审阅原参考片并手动设置切点</button>}
      {!!cutLimits?.uncertainCuts?.length && <section aria-label="人工审阅疑似切点">
        <p>需人工核对的疑似位置（未计入切点，不代表切镜，也不是概率）：</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{cutLimits.uncertainCuts.map((item, index) => <button key={`${item.timeMs}-${index}`} type="button" style={button} disabled={!source || busy || disabled} onClick={() => void openReview(item.timeMs)}>审阅 {(item.timeMs / 1000).toFixed(2)} 秒</button>)}</div>
        {!source && <small>原参考片信息不可用，请重新分析。</small>}
      </section>}
      {reviewUrl && source && <section aria-label="原片审阅">
        <video ref={videoRef} aria-label="原参考片" controls preload="metadata" src={applicationUrl(reviewUrl)} style={{ width: "100%", maxWidth: 560 }} onLoadedMetadata={event => { const at = Number(reviewAt); if (Number.isFinite(at)) event.currentTarget.currentTime = at; }} onError={() => setError("参考片播放失败，请重新分析或检查浏览器。")}/>
        <p>播放器加载的是经 SHA-256 校验的原片快照；下方时间可人工修改。分割后两镜暂用同一参考帧。</p>
        <label>切点秒数 <input aria-label="人工切点秒数" type="number" min="0" max={source.durationMs / 1000} step="0.001" style={{ ...field, width: 120 }} value={reviewAt} onChange={event => setReviewAt(event.target.value)} /></label>{" "}
        <button type="button" style={button} onClick={() => { const time = Number(reviewAt); if (!reviewAt.trim() || !Number.isFinite(time) || time < 0 || time * 1000 >= source.durationMs || !videoRef.current) { setError("切点时间超出原片范围。"); return; } videoRef.current.currentTime = time; setError(""); }}>定位原片</button>{" "}
        <button type="button" style={button} onClick={() => { if (videoRef.current) setReviewAt(videoRef.current.currentTime.toFixed(3)); }}>使用播放位置</button>
        <label><input type="checkbox" checked={duplicateNarration} onChange={event => setDuplicateNarration(event.target.checked)} />我确认分割会在两镜复制当前旁白和画面内容，随后人工调整</label>{" "}
        <button type="button" style={button} disabled={disabled || busy || !canCorrectCurrent || !duplicateNarration} onClick={() => {
          try {
            const snapshot = latestProject.current;
            if (!snapshot || !referenceTimeline || !reviewAt.trim()) throw new Error("请重新分析并输入切点。");
            const currentTimeline = JSON.stringify(buildTimeline(snapshot).entries.map(entry => [entry.scene.id, entry.startMs, entry.durationMs]));
            if (currentTimeline !== referenceTimeline) throw new Error("工程镜头时间已变化，请重新分析后再按原片时间插入。");
            const target = Math.round(Number(reviewAt) * 1000);
            if (!Number.isSafeInteger(target) || target <= 0 || target >= source.durationMs) throw new Error("切点时间超出原片范围。");
            const updated = splitReferenceAt(snapshot, target, `ref-manual-${crypto.randomUUID()}`);
            if (onProject(updated) === false) throw new Error("工程保存失败，未插入切点。");
            setReferenceTimeline(JSON.stringify(buildTimeline(updated).entries.map(entry => [entry.scene.id, entry.startMs, entry.durationMs])));
            setError(""); setNotice("已插入人工切点；两镜暂用同一参考帧和旁白，请分别核对。");
          } catch (cause) { setError(cause instanceof Error ? cause.message : "切点无法插入。"); }
        }}>插入人工切点</button>
        {!canCorrectCurrent && <small>当前工程已切换，请重新分析。</small>}
      </section>}
      {built && <details>
        <summary>切点测量 · {boundaries.length} 处</summary>
        <small>变化强度是切点前后采样帧的平均亮度差（0–100%），不是切点正确概率。快速运动、闪光和颜色变化都可能影响结果；请在编辑器中核对镜长。</small>
        {cutLimits && <p>合并近邻切点 {cutLimits.mergedCuts} 处 · 超出镜头上限省略 {cutLimits.omittedCuts} 处 · 自适应候选因数量上限未复核 {cutLimits.adaptiveCandidatesSkipped ?? 0} 处（未计入切点）</p>}
        <small>可调整当前工程中相邻镜头的分界，再手动重抽两镜的中点参考帧；原始亮度测量不会改变。交叠转场的分界按转场中心计算，重抽仍取两镜各自的中点帧。</small>
        {boundaries.length > 0 ? <ol>{boundaries.map(entry => {
          const original = built.project as SceneScriptProject, index = original.scenes?.findIndex(scene => scene.id === entry.sceneId) ?? -1;
          const previousId = index > 0 ? original.scenes[index - 1]?.id : undefined;
          const timelineEntries = canCorrectCurrent && currentProject ? buildTimeline(currentProject).entries : undefined;
          const current = timelineEntries?.find(item => item.scene.id === entry.sceneId);
          const currentCenter = current && timelineEntries ? (() => { const position = timelineEntries.indexOf(current); const before = position > 0 ? timelineEntries[position - 1]! : undefined; const overlap = before ? Math.max(0, before.startMs + before.durationMs - current.startMs) : 0; return current.startMs + overlap / 2; })() : undefined;
          return <li key={entry.sceneId}>
            {entry.sceneId} · 原始 {(entry.startMs / 1000).toFixed(2)} 秒 · 变化强度 {entry.change === null ? "无法测量" : `${Math.round(entry.change * 100)}%`}
            {currentCenter !== undefined && <span> · 当前 {(currentCenter / 1000).toFixed(2)} 秒</span>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <label>调整至秒数 <input aria-label={`切点时间 ${entry.sceneId}`} type="number" min="0" step="0.01" style={{ ...field, width: 110 }} value={boundaryDrafts[entry.sceneId] ?? ""} onChange={event => setBoundaryDrafts(value => ({ ...value, [entry.sceneId]: event.target.value }))} /></label>
              <button type="button" style={button} disabled={disabled || busy || !canCorrectCurrent || !current || !previousId || !(boundaryDrafts[entry.sceneId] ?? "").trim()} onClick={() => {
                if (!currentProject || !canCorrectCurrent || !previousId) return;
                try {
                  const seconds = Number(boundaryDrafts[entry.sceneId]), ms = Math.round(seconds * 1000);
                  if (onProject(moveReferenceBoundary(currentProject, entry.sceneId, previousId, ms)) === false) throw new Error("工程保存失败，切点未调整。");
                  setError(""); setNotice("切点已调整；相邻镜头总时长保持不变，参考帧未重新抽取。");
                } catch (cause) { setError(cause instanceof Error ? cause.message : "切点无法调整。"); }
              }}>调整此切点</button>
              <button type="button" style={button} disabled={disabled || busy || !source || !canCorrectCurrent || !current || !previousId} onClick={() => { if (previousId) void refreshFrames(entry.sceneId, previousId); }}>重抽相邻参考帧</button>
            </div>
          </li>;
        })}</ol> : <p>没有可测量的切点。</p>}
      </details>}
      {built && <div aria-label="人工纠正风格提案" style={{ display: "grid", gap: 8, paddingTop: 4 }}>
        <small>对推断不满意？手动纠正后会回写工程主题（主色/强调色）与每镜时长。</small>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label>主色<select aria-label="纠正主色" style={{ ...field, minWidth: 140, width: "auto" }} value={correction.background} onChange={event => setCorrection(value => ({ ...value, background: event.target.value }))}>
            <option value="">保持推断</option>
            {(built.style?.palette ?? style).map(entry => <option key={entry.hex} value={entry.hex}>{entry.hex}</option>)}
          </select></label>
          <label>强调色<select aria-label="纠正强调色" style={{ ...field, minWidth: 140, width: "auto" }} value={correction.accent} onChange={event => setCorrection(value => ({ ...value, accent: event.target.value }))}>
            <option value="">保持推断</option>
            {(built.style?.palette ?? style).map(entry => <option key={entry.hex} value={entry.hex}>{entry.hex}</option>)}
          </select></label>
          <label>每镜秒数<input aria-label="纠正镜长" type="number" min={0.5} max={120} step={0.5} placeholder="保持推断" style={{ ...field, width: 110 }} value={correction.shotSeconds} onChange={event => setCorrection(value => ({ ...value, shotSeconds: event.target.value }))} /></label>
          <button type="button" style={button} disabled={disabled || !canCorrectCurrent || lockedDuration || (!correction.background && !correction.accent && !Number(correction.shotSeconds))} onClick={() => {
            if (!built || !currentProject || !canCorrectCurrent || lockedDuration) return;
            const seconds = Number(correction.shotSeconds);
            const corrected = applyManualCorrection(currentProject, {
              ...(correction.background ? { background: correction.background } : {}),
              ...(correction.accent ? { accent: correction.accent } : {}),
              ...(seconds > 0 ? { shotSeconds: seconds } : {}),
            });
            onProject(corrected);
            setNotice("已按人工纠正回写工程：主题与镜长已更新，可继续在编辑器里调整。");
          }}>应用纠正并回写工程</button>
        </div>
        {!canCorrectCurrent && <small>当前工程已切换，请重新分析参考片后再应用纠正。</small>}
        {lockedDuration && <small>工程含锁定镜头，请解锁后再统一修改镜长。</small>}
      </div>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
  </details>;
}
/** XHR upload with byte progress; fetch cannot report upload progress. */
export function uploadReferenceVideo(file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<{ name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => { xhr.abort(); reject(new DOMException("Aborted", "AbortError")); };
    xhr.open("POST", "/api/reference/upload");
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error("上传失败，请检查网络后重试。"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && typeof body?.name === "string") resolve({ name: body.name });
        else reject(new Error(typeof body?.error === "string" ? body.error : "上传失败，请检查文件后重试。"));
      } catch { reject(new Error("上传响应无法解析，请重试。")); }
    };
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);
    xhr.onloadend = done;
    xhr.send(file);
  });
}
