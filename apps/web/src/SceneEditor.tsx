import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { lazy, Suspense, useState, useEffect, useRef, type ReactNode } from "react";
import { buildTimeline, editTimeline, parseProject, type ProjectWorkspace, type SceneScriptProject } from "@glintai/scenescript";
import { captureProjectWorkspace, gitProjectKey, prepareGitStorage, recoverGitStorage } from "./project-git-storage";
import { clearPendingAuthoringDrafts, readPendingDesignDocuments, readPendingScriptDocuments } from "./authoring-drafts";
import { projectBrandKey } from "./design-brand";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { boardContentIdentity, type BoardContent, type BoardContentAction } from "./project-board-content";
import type { ProjectBoardTarget } from "./ProjectBoard";
import { AuthoringVisibility } from "./authoring-visibility";
import { projectAssetsKey } from "./design-assets";
import { canDeleteScene, canMoveScene, changeNarration, downloadJson, downloadText, duplicateScene, moveScene, reorderScenes, sceneDisplayTitle } from "./editor-model";
import { PreviewBoundary } from "./PreviewBoundary";
import { ShapeMorphPanel } from "./ShapeMorphPanel";
import { SceneTimelineDock, guardWorkspaceViewChange } from "./SceneTimelineDock";
import { EffectsPanel } from "./EffectsPanel";
import { EditorAssistant } from "./EditorAssistant";
import { PanelBoundary } from "./PanelBoundary";
import { adoptLibraryVisual } from "./media-adoption";
import { createProjectDocuments, readProjectDocuments, projectDocumentsKey, previewScriptScenes, type ProjectDocuments, type ScriptDocument, type ScriptSelection, type ScriptEditHandle, type ScriptHistoryState } from "./script-documents";
import type { DesignDocument, DesignSelection, ProjectDesignDocuments } from "./design-artifacts";
import { designDocumentsKey, readProjectDesignDocuments } from "./design-artifacts";
import { ArtifactChat } from "./ArtifactChat";
import type { ArtifactEditRequest, DesignEditHandle } from "./artifact-project";
import { DirectorEye } from "./DirectorEye";
import "./editor-workspace.css";
const ASPECT_SIZE: Record<string, [number, number]> = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] };
function aspectWidth(aspect: string): number { return ASPECT_SIZE[aspect]?.[0] ?? 1920; }
function aspectHeight(aspect: string): number { return ASPECT_SIZE[aspect]?.[1] ?? 1080; }
const SaveCreationPack = lazy(() => import("./SaveCreationPack").then(module => ({ default: module.SaveCreationPack })));
const ShotCanvas = lazy(() => import("./ShotCanvas").then(module => ({ default: module.ShotCanvas })));
const MediaCandidates = lazy(() => import("./MediaCandidates").then(module => ({ default: module.MediaCandidates })));
const SceneGenerator = lazy(() => import("./SceneGenerator").then(module => ({ default: module.SceneGenerator })));
const HybridSceneTools = lazy(() => import("./HybridSceneTools").then(module => ({ default: module.HybridSceneTools })));
const StylePackPicker = lazy(() => import("./StylePackPicker").then(module => ({ default: module.StylePackPicker })));
const CraftQuality = lazy(() => import("./CraftQuality").then(module => ({ default: module.CraftQuality })));
const VoiceWaveform = lazy(() => import("./VoiceWaveform").then(module => ({ default: module.VoiceWaveform })));
const CharacterIdentityPanel = lazy(() => import("./CharacterIdentityPanel").then(module => ({ default: module.CharacterIdentityPanel })));

const Preview = lazy(() => import("./ProjectPreview"));
const ProjectBoard = lazy(() => import("./ProjectBoard").then(module => ({ default: module.ProjectBoard })));
const SceneBoard = lazy(() => import("./SceneBoard").then(module => ({ default: module.SceneBoard })));
const ScriptEditor = lazy(() => import("./ScriptEditor").then(module => ({ default: module.ScriptEditor })));
const StoryboardWorkbench = lazy(() => import("./StoryboardWorkbench").then(module => ({ default: module.StoryboardWorkbench })));
const ProjectGitPanel = lazy(() => import("./ProjectGitPanel").then(module => ({ default: module.ProjectGitPanel })));
const ProjectDesignWorkspace = lazy(() => import("./ProjectDesignWorkspace").then(module => ({ default: module.ProjectDesignWorkspace })));
const button = { background: "var(--ink-3)", border: "1px solid var(--line-2)", color: "var(--paper)", padding: "7px 11px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13 };
const field = { width: "100%", minWidth: 0, padding: 9, borderRadius: 8, border: "1px solid var(--line-2)", color: "var(--paper)", background: "var(--ink-2)", font: "inherit", fontSize: 13 };
const names: Record<string, string> = { title: "标题", subtitle: "副标题", heading: "小标题", text: "正文", term: "术语", definition: "释义", attribution: "出处", caption: "说明", label: "标签", note: "补充", code: "代码", language: "语言", items: "要点", points: "条目", left: "左侧", right: "右侧", steps: "步骤", data: "图表数据", value: "数值", unit: "单位" };

function editable(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; text: string | number }[] {
  if (typeof value === "string" || typeof value === "number") return [{ path, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([key]) => !["id", "kind", "narration", "src", "chartType", "effects", "tracks", "elements", "assetRefs"].includes(key)).flatMap(([key, child]) => editable(child, [...path, Array.isArray(value) ? Number(key) : key]));
}

/** Source labels who drove the change: "user" (manual panels) or "product-agent" (AI assistant).
 * The session layer (SessionEditor) turns the label into the transaction actor so every
 * entry point shares one ProjectSession undo stack (CORE-03). */
export type EditSource = "user" | "product-agent";

type SceneEditorProps = Parameters<typeof ProjectSceneEditor>[0];

// 项目切换是任务、历史与选择的明确生命周期边界。
export function SceneEditor(props: SceneEditorProps) { return <ProjectSceneEditor key={props.project.id} {...props} />; }

function RetainedPane({ active, children }: { active: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  useEffect(() => {
    if (!active && root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
  }, [active]);
  return <div ref={root} className="glint-retained-pane" hidden={!active} inert={!active} aria-hidden={!active}
    onKeyDownCapture={event => { if (!active) { event.preventDefault(); event.stopPropagation(); } }}>
    {visited ? <AuthoringVisibility active={active}>{children}</AuthoringVisibility> : null}
  </div>;
}

function ProjectSceneEditor({ project, onChange, onFork, onGitAccepted, onOpenTimeline, voiceEngine = "mock", documentOnly = false, history, selection, onSelect, onApproveCharacter, canApproveCharacter, onApproveProduct, canApproveProduct, onAdoptReferenceCandidate }: { project: SceneScriptProject; onChange(project: SceneScriptProject, source?: EditSource): void; onFork?(project: SceneScriptProject): void; onGitAccepted?(project: SceneScriptProject): void; voiceEngine?: string; onOpenTimeline?(project:SceneScriptProject):void; onApproveCharacter?: (id: string) => Promise<boolean>; canApproveCharacter?: boolean; onApproveProduct?: (id: string) => Promise<boolean>; canApproveProduct?: boolean; onAdoptReferenceCandidate?: (taskId: string, mode: "replace" | "insert") => Promise<boolean>;
  documentOnly?: boolean; history?: { undoDepth: number; redoDepth: number; undo(): void; redo(): void }; selection?: string[]; onSelect?(handle: string): void;
}) {
  const [restoreError] = useState(() => { try { if (!documentOnly) recoverGitStorage(project.id); return ""; } catch (cause) { return cause instanceof Error ? cause.message : "本机版本恢复未完成，请先备份并核对。"; } });
  const [selected, setSelected] = useState(0);
  const [past, setPast] = useState<SceneScriptProject[]>([]);
  const [future, setFuture] = useState<SceneScriptProject[]>([]);
  const [preview, setPreview] = useState(true);
  const [tab, setTab] = useState<"content" | "visual" | "audio" | "generate" | "assistant">("content");
  const [visitedVisual, setVisitedVisual] = useState(false);
  const [originalView, setOriginalView] = useState(false);
  const [boardView, setBoardView] = useState(false);
  const [scriptView, setScriptView] = useState(false);
  const [designView, setDesignView] = useState(false);
  const [storyboardView, setStoryboardView] = useState(false);
  const [visitedPanes, setVisitedPanes] = useState({ script: false, design: false, canvas: false });
  const scriptEditHandle = useRef<ScriptEditHandle | null>(null);
  const [scriptHistory, setScriptHistory] = useState<ScriptHistoryState>({ canUndo: false, canRedo: false });
  const [designHistory, setDesignHistory] = useState<ScriptHistoryState>({ canUndo: false, canRedo: false });
  const [designSelection, setDesignSelection] = useState<DesignSelection>();
  const [designState, setDesignState] = useState<ProjectDesignDocuments>(() => {
    try { if (documentOnly) return { version: 1, projectId: project.id, documents: [], activeId: "" }; return readPendingDesignDocuments(project.id) ?? readProjectDesignDocuments(project.id); } catch { return { version: 1, projectId: project.id, documents: [], activeId: "" }; }
  });
  const [designRevision, setDesignRevision] = useState(0);
  const designEditHandle = useRef<DesignEditHandle | null>(null);
  const [designReview, setDesignReview] = useState<ArtifactEditRequest>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [documents, setDocuments] = useState<ProjectDocuments>(() => {
    try { if (documentOnly) return createProjectDocuments(project); const pending = readPendingScriptDocuments(project.id); if (pending) return pending; const saved = readProjectDocuments(project.id); return saved.documents.length ? saved : createProjectDocuments(project); }
    catch { return createProjectDocuments(project); }
  });
  const [documentVersion, setDocumentVersion] = useState(0);
  const [scriptSelection, setScriptSelection] = useState<ScriptSelection>();
  const [boardTarget, setBoardTarget] = useState<(ProjectBoardTarget & {nonce:number})>();
  const [boardNotice, setBoardNotice] = useState("");
  const [boardPast, setBoardPast] = useState<Array<{before:BoardContent;after:BoardContent}>>([]);
  const [boardFuture, setBoardFuture] = useState<Array<{before:BoardContent;after:BoardContent}>>([]);
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
  const seekSequence = useRef(0);
  const [previewSeek, setPreviewSeek] = useState<{ sceneId: string; timeMs: number; sequence: number }>();
  const seekPreview = (sceneId: string, timeMs: number) => setPreviewSeek({ sceneId, timeMs, sequence: ++seekSequence.current });
  const handlePreviewSeek = (sequence: number) => setPreviewSeek(current => current?.sequence === sequence ? undefined : current);
  useEffect(() => { setPreviewSeek(current => current && current.sceneId !== scene.id ? undefined : current); }, [scene.id]);
  useEffect(() => {
    setVoiceAudio(null); setVoiceError("");
    return () => previewRequest.current?.abort();
  }, [scene.id, scene.narration.text, scene.narration.voice, scene.narration.speakingRate, voiceEngine]);
  useEffect(() => () => { if (voiceAudio) URL.revokeObjectURL(voiceAudio); }, [voiceAudio]);
  const timeline = buildTimeline(project);
  const fps = project.fps ?? 30;
  const posterFrame = Math.min(Math.round(1.2 * fps), Math.max(0, Math.round(((timeline.entries[index]?.durationMs ?? 0) / 1000) * fps) - 1));
  // Local history is also kept while the shared session is connected: if saving fails, the draft
  // must remain undoable instead of freezing the last keystrokes behind an unavailable server.
  const commit = (next: SceneScriptProject, source: EditSource = "user") => { setPast(items => [...items, project].slice(-30)); setFuture([]); onChange(next, source); };
  const storageSignature = () => JSON.stringify([projectDocumentsKey(project.id), designDocumentsKey(project.id), projectBrandKey(project.id), projectAssetsKey(project.id), gitProjectKey(project.id), `glint:project-board:v1:${project.id}`, `glint:project-board:viewport:v1:${project.id}`, "glint.workspace"].map(key => localStorage.getItem(key)).concat(JSON.stringify(captureProjectWorkspace(project.id))));
  const applyDocuments = (nextProject: SceneScriptProject, nextDocuments?: ScriptDocument[], workspace?: ProjectWorkspace) => {
    if (restoreError) throw new Error(restoreError);
    const next = nextDocuments === undefined ? undefined : { version: 1 as const, projectId: nextProject.id, documents: nextDocuments, activeId: nextDocuments.some(item => item.id === documents.activeId) ? documents.activeId : nextDocuments[0]?.id ?? "" };
    const accepts: Array<() => void> = [];
    if (next && visitedPanes.script) {
      const handle = scriptEditHandle.current;
      const accept = next.documents.length ? handle?.prepareRestore?.(next, documents) : handle?.prepareDeactivate?.(documents);
      if (!accept) throw new Error("脚本编辑器尚未准备好接收版本，请等待加载完成后重试。");
      accepts.push(accept);
    }
    if (workspace && visitedPanes.design) {
      const handle = designEditHandle.current;
      const accept = workspace.designs.documents.length ? handle?.prepareRestore?.(workspace.designs, designState) : handle?.prepareDeactivate?.(designState);
      if (!accept) throw new Error("设计编辑器尚未准备好接收版本，请等待加载完成后重试。");
      accepts.push(accept);
    }
    const transaction = prepareGitStorage(nextProject.id, next, workspace, undefined, false, nextProject);
    transaction.write();
    try { transaction.commit(); onChange(nextProject); }
    catch (cause) { transaction.rollback(); throw cause; }
    // Disk already contains the whole accepted version. Cleanup failure must never undo only attachments.
    for (const accept of accepts) accept();
    clearPendingAuthoringDrafts(project.id, { script: next !== undefined, design: workspace !== undefined });
    const warning = transaction.finish();
    let registrationWarning = "";
    try { onGitAccepted?.(nextProject); }
    catch { registrationWarning = "完整版本已保存到本机；作品列表登记未确认，请在工作区重试。"; }
    setOrderNotice(registrationWarning || warning || "完整版本已保存到本机；共享保存状态请查看工程同步栏。");
    setPast(items => [...items, project].slice(-30)); setFuture([]);
    if (next) {
      setDocuments(next); setDocumentVersion(value => value + 1); setScriptSelection(undefined);
      if (!next.documents.length) { setScriptView(false); setVisitedPanes(value => ({ ...value, script: false })); }
    }
    if (workspace) {
      setDesignState(workspace.designs); setDesignRevision(value => value + 1); setDesignSelection(undefined); setDesignReview(undefined);
      if (!workspace.designs.documents.length) { setDesignView(false); setVisitedPanes(value => ({ ...value, design: false })); }
    }
    return true;
  };
  const boardSnapshot = (): BoardContent => ({project, scripts: documents, workspace: captureProjectWorkspace(project.id, designState)});
  const boardChange = (action: BoardContentAction, next: BoardContent, expected: string) => {
    assertAuthoringCanLeave([project.id]);
    const before = boardSnapshot();
    if (boardContentIdentity(before) !== expected) throw new Error("画布内容已变化，请重新选择后操作。");
    applyDocuments(next.project, next.scripts.documents, {...before.workspace, designs:next.workspace.designs, board:next.workspace.board});
    setBoardPast(items=>[...items.slice(-29),{before,after:next}]); setBoardFuture([]);
    setBoardNotice(action.kind === "delete" ? "已删除选中内容，素材原文件保留。可撤销内容。" : "已保存画布内容修改，可撤销。");
  };
  const boardHistory = (redo = false) => {
    try {
      assertAuthoringCanLeave([project.id]);
      const entry = (redo ? boardFuture : boardPast).at(-1); if (!entry) return;
      const current = boardSnapshot(), expected = redo ? entry.before : entry.after, target = redo ? entry.after : entry.before;
      if (boardContentIdentity(current) !== boardContentIdentity(expected)) throw new Error("内容已有后续修改，请先撤销对应编辑器中的修改；未覆盖新版本。");
      applyDocuments(target.project,target.scripts.documents,{...current.workspace,designs:target.workspace.designs,board:{positions:target.workspace.board?.positions ?? {},...(target.workspace.board?.groups?{groups:target.workspace.board.groups}:{}),...(current.workspace.board?.viewport ? {viewport:current.workspace.board.viewport}: {})}});
      if (redo) {setBoardFuture(items=>items.slice(0,-1));setBoardPast(items=>[...items,entry]);}
      else {setBoardPast(items=>items.slice(0,-1));setBoardFuture(items=>[...items,entry]);}
      setBoardNotice(redo ? "已重做画布内容修改。" : "已撤销画布内容修改。");
    } catch (cause) {setBoardNotice(cause instanceof Error ? cause.message : "未恢复内容，当前版本保留。");}
  };
  const copyDocuments = (nextProject: SceneScriptProject, nextDocuments?: ScriptDocument[], workspace?: ProjectWorkspace) => {
    if (!onFork) return false;
    const next = nextDocuments === undefined ? undefined : { version: 1 as const, projectId: nextProject.id, documents: nextDocuments, activeId: nextDocuments[0]?.id ?? "" };
    const transaction = prepareGitStorage(nextProject.id, next, workspace, undefined, true, nextProject);
    transaction.write();
    try { transaction.commit(); onFork(nextProject); }
    catch (cause) { transaction.rollback(); throw cause; }
    const warning = transaction.finish();
    try { onGitAccepted?.(nextProject); }
    catch { setOrderNotice("完整副本已保存到本机；作品列表登记未确认，请在工作区重试。"); }
    if (warning) setOrderNotice(warning);
    return true;
  };
  // The right-hand conversation follows the document you are actually looking at.
  const activeDesign = designState.documents.find(item => item.id === designState.activeId) ?? designState.documents[0];
  const activeScript = documents.documents.find(item => item.id === documents.activeId) ?? documents.documents[0];
  const applyDesignDocument = (before: DesignDocument, document: DesignDocument) => {
    return designEditHandle.current?.apply(before, document) ?? false;
  };
  const applyScriptDocument = (before: ScriptDocument, document: ScriptDocument) => {
    return scriptEditHandle.current?.apply(before, document) ?? false;
  };
  const buildScript = (document: ScriptDocument) => {
    const parts = previewScriptScenes(document);
    if (!parts.length) return;
    if (parts.length > 30) throw new Error("脚本超过 30 个镜头，请先合并部分段落。");
    const next = parseProject({ ...project, id: `${project.id.slice(0, 42)}-script-${crypto.randomUUID().slice(0, 8)}`,
      title: document.title, frozen: false,
      assets: project.assets?.map(({ approval, ...asset }) => asset),
      scenes: parts.map((part, index) => ({ id: `script-${index + 1}`, kind: "title", title: part.title, narration: { text: part.narration } })) });
    if (!onFork) throw new Error("请先打开共享工程，再从脚本创建新作品。");
    onFork(next);
  };
  const undo = () => {
    if ((storyboardView || documentOnly) && history) { history.undo(); return; }
    if (designView && !storyboardView) { designEditHandle.current?.undo(); return; }
    if (scriptView && !storyboardView) { scriptEditHandle.current?.undo(); return; }
    if (boardPast.length && boardContentIdentity(boardSnapshot()) === boardContentIdentity(boardPast.at(-1)!.after)) { boardHistory(); return; }
    if (history && history.undoDepth > 0) { setPast([]); setFuture([]); history.undo(); return; }
    const previous = past.at(-1); if (previous) { setFuture(items => [project, ...items]); setPast(items => items.slice(0, -1)); onChange(previous); }
  };
  const redo = () => {
    if ((storyboardView || documentOnly) && history) { history.redo(); return; }
    if (designView && !storyboardView) { designEditHandle.current?.redo(); return; }
    if (scriptView && !storyboardView) { scriptEditHandle.current?.redo(); return; }
    if (boardFuture.length && boardContentIdentity(boardSnapshot()) === boardContentIdentity(boardFuture.at(-1)!.before)) { boardHistory(true); return; }
    if (history && history.redoDepth > 0) { setPast([]); setFuture([]); history.redo(); return; }
    const next = future[0]; if (next) { setPast(items => [...items, project]); setFuture(items => items.slice(1)); onChange(next); }
  };
  const canUndo = (storyboardView || documentOnly) ? Boolean(history ? history.undoDepth : past.length) : designView ? designHistory.canUndo : scriptView ? scriptHistory.canUndo : boardView && boardPast.length > 0 || Boolean(history && history.undoDepth > 0) || past.length > 0;
  const canRedo = (storyboardView || documentOnly) ? Boolean(history ? history.redoDepth : future.length) : designView ? designHistory.canRedo : scriptView ? scriptHistory.canRedo : boardView && boardFuture.length > 0 || Boolean(history && history.redoDepth > 0) || future.length > 0;
  type EditorVersion = { id: string; name: string; at: string; project: SceneScriptProject };
  const versionKey = `glint.editor.versions:${project.id}`;
  const readVersions = (): EditorVersion[] => { if (documentOnly) return [];
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
      const link = document.createElement("a"); link.href = applicationUrl(data.url); link.download = typeof data.file === "string" ? data.file : `${project.id}.${format}`; link.click();
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
      ? <video key={src} aria-hidden muted preload="metadata" src={applicationUrl(src)} style={{ width: "100%", height: 48, objectFit: "cover", borderRadius: 8, display: "block" }} />
      : <img key={src} alt="" src={applicationUrl(src)} style={{ width: "100%", height: 48, objectFit: "cover", borderRadius: 8, display: "block" }} />;
  };
  return <div className="glint-editor" data-view={designView ? "design" : scriptView ? "script" : boardView ? "canvas" : "video"} aria-label="分镜编辑器" onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  }}>

    <header className="glint-editor-top">
      <div className="glint-editor-id">
        <span className="g-label">作品</span>
        <strong className="glint-editor-title">{project.title || "未命名工程"}</strong>
        <span className="glint-editor-meta g-num">{project.scenes.length} 个分镜 · {(timeline.totalMs / 1000).toFixed(1)}s · 第 {index + 1} 镜</span>
      </div>
      <div className="g-seg glint-view-switch" role="group" aria-label="工作区视图" onClickCapture={event => { if (storyboardView) guardWorkspaceViewChange(event, setBoardNotice, true); }}>
        <button type="button" aria-pressed={!boardView && !scriptView && !designView && !storyboardView} onClick={() => { setBoardView(false); setScriptView(false); setDesignView(false); setStoryboardView(false); }}>作品</button>
        <button type="button" disabled={documentOnly} aria-pressed={boardView && !scriptView && !designView && !storyboardView} onClick={() => { setVisitedPanes(value => ({ ...value, canvas: true })); setBoardView(true); setScriptView(false); setDesignView(false); setStoryboardView(false); }}>创意</button>
        <button type="button" disabled={documentOnly} aria-pressed={scriptView && !designView && !storyboardView} onClick={() => { setVisitedPanes(value => ({ ...value, script: true })); setScriptView(true); setDesignView(false); setStoryboardView(false); }}>脚本</button>
        <button type="button" disabled={documentOnly} aria-pressed={storyboardView} onClick={() => setStoryboardView(true)}>分镜</button>
        <button type="button" disabled={documentOnly} aria-pressed={designView && !storyboardView} onClick={() => { setVisitedPanes(value => ({ ...value, design: true })); setDesignView(true); setStoryboardView(false); }}>设计</button>
      </div>
      <div className="glint-editor-actions">
        <button type="button" className="g-btn g-btn--icon g-btn--quiet" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={event => { if (!storyboardView || guardWorkspaceViewChange(event, setBoardNotice)) undo(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg><span className="g-sr">撤销</span>
        </button>
        <button type="button" className="g-btn g-btn--icon g-btn--quiet" aria-label="重做" title="重做" disabled={!canRedo} onClick={event => { if (!storyboardView || guardWorkspaceViewChange(event, setBoardNotice)) redo(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg><span className="g-sr">重做</span>
        </button>
        <span className="g-vrule" aria-hidden="true" />
        <details className="glint-menu-wrap">
          <summary className="g-btn g-btn--quiet" title="命名版本与 Git 历史">版本 <span className="g-num">{versions.length}</span></summary>
          <div className="g-menu glint-menu">
            <button type="button" disabled={documentOnly} onClick={saveVersion}>保存版本</button>
            <button type="button" disabled={documentOnly} onClick={() => setGitOpen(true)}>Git 改动与历史…</button>
            <hr className="g-divider" />
            {versions.length === 0 ? <small>还没有命名版本。保存一次后可以随时回到这里。</small> : versions.map(version => <button key={version.id} type="button" onClick={() => restoreVersion(version)}>{version.name}<small>{new Date(version.at).toLocaleString()}</small></button>)}
          </div>
        </details>
        <details className="glint-menu-wrap">
          <summary className="g-btn g-btn--quiet" title="画面、工程文件与交换格式">{exporting ? "导出中…" : "更多格式"}</summary>
          <div className="g-menu glint-menu glint-menu--wide">
            <span className="g-label">画面</span>
            <button type="button" disabled={Boolean(exporting)} onClick={() => void exportProjectFile("gif")}>{exporting === "gif" ? "正在渲染 GIF…" : "GIF · 前段 50%"}</button>
            <button type="button" disabled={Boolean(exporting)} onClick={() => void exportProjectFile("png")}>{exporting === "png" ? "正在渲染 PNG…" : "当前镜 PNG"}</button>
            <hr className="g-divider" />
            <span className="g-label">交给剪辑软件</span>
            <button type="button" disabled={Boolean(exporting)} onClick={() => void exportNle("fcpxml")}>{exporting === "fcpxml" ? "正在渲染母版…" : "FCPXML · 按镜头切点"}</button>
            <button type="button" disabled={Boolean(exporting)} onClick={() => void exportNle("edl")}>{exporting === "edl" ? "正在渲染母版…" : "EDL · 通用剪辑表"}</button>
            <hr className="g-divider" />
            <span className="g-label">工程与字幕</span>
            <button type="button" onClick={() => downloadJson(`${project.id}.scenescript.json`, project)}>工程 JSON</button>
            <button type="button" onClick={async () => {
              try {
                const response = await fetch("/api/project/srt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }), signal: AbortSignal.timeout(20_000) });
                if (!response.ok) throw new Error("字幕导出失败，请检查工程后重试。");
                const data = await response.json();
                if (typeof data?.srt !== "string" || !data.srt.trim()) throw new Error("字幕为空：请先填写旁白。");
                downloadText(typeof data.name === "string" ? data.name : `${project.id}.srt`, data.srt);
                setSrtStatus("已导出字幕 SRT。");
              } catch (error) { setSrtStatus(error instanceof Error ? error.message : "字幕导出失败。"); }
            }}>字幕 SRT</button>
            <small>FCPXML/EDL 会先渲染母版 MP4；GIF 只出前段、半尺寸。未在 FCP/Premiere/Resolve 真机验证。</small>
            {nleResult && <div className="glint-menu-result">
              <a href={applicationUrl(nleResult.url)} download={nleResult.file}>下载 {nleResult.format === "fcpxml" ? "FCPXML" : "EDL"}（{nleResult.cuts} 切点）</a>
              <a href={applicationUrl(nleResult.master.url)} download={nleResult.master.file}>下载母版 MP4（{Math.round(nleResult.master.bytes / 1024)} KB）</a>
              <small>两个文件放在同一台机器上再导入；母版路径已写进时间线。</small>
            </div>}
          </div>
        </details>
        {!boardView && !scriptView && !designView && <button type="button" className="g-btn g-btn--quiet" aria-expanded={inspectorOpen} aria-controls="glint-inspector" onClick={() => setInspectorOpen(value => !value)}>属性</button>}
      </div>
      {(srtStatus || orderNotice || boardNotice) && <div className="glint-editor-status">
        {srtStatus && <span role="status">{srtStatus}</span>}
        {orderNotice && <span role="status">{orderNotice}</span>}
        {boardNotice && <span role="status">{boardNotice}</span>}
      </div>}
    </header>

    <div className="glint-editor-workspace">
      {storyboardView && <Suspense fallback={<p role="status">正在打开分镜…</p>}><StoryboardWorkbench onApply={commit} project={project} screenplays={documents.documents.filter(item => item.kind === "screenplay")} onOpenScript={() => { setVisitedPanes(value => ({ ...value, script: true })); setScriptView(true); setDesignView(false); setStoryboardView(false); }} /></Suspense>}
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
            <span className="glint-rail-thumb">{thumb(item) ?? (thumbs[item.id] ? <img src={applicationUrl(thumbs[item.id])} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <span className="glint-kind">{item.kind}</span>)}</span>
            <span className="glint-rail-meta"><strong title={sceneDisplayTitle(item)}>{String(position + 1).padStart(2, "0")} · {sceneDisplayTitle(item)}</strong><small>{(timeline.entries[position]!.durationMs / 1000).toFixed(1)} 秒</small></span>
          </button>)}
        </div>
        <small style={{ color: "var(--muted)" }}>拖动排序；画布位置不改变播放顺序。</small>
      </aside>

      <div className="glint-editor-center">
      <section className="glint-editor-stage" aria-label="舞台">
        <div className="glint-stage-head">
          <span className="glint-stage-kind">第 {index + 1} 镜 · {sceneDisplayTitle(scene)}</span>
          <span className="glint-stage-id g-num">{scene.id}</span>
          <button type="button" className="g-btn g-btn--sm g-btn--quiet glint-stage-preview" onClick={() => setPreview(value => !value)}>{preview ? "收起预览" : "播放预览"}</button>
        </div>
        {visitedPanes.design && <RetainedPane active={designView}><Suspense fallback={<p role="status">正在打开设计工作区…</p>}><ProjectDesignWorkspace openTarget={boardTarget?.kind === "design" ? boardTarget : undefined} project={project} state={designState.documents.length ? designState : undefined} revision={designRevision} onChange={setDesignState} onSelection={setDesignSelection} onReview={setDesignReview} editHandle={designEditHandle} onHistoryChange={setDesignHistory} onAppendSlides={next => {
          assertAuthoringCanLeave([project.id]);
          const first = project.scenes.length; commit(next); selectScene(next.scenes[first]!.id);
          setBoardView(false); setScriptView(false); setDesignView(false);
          setOrderNotice(`已把 ${next.scenes.length-first} 页幻灯片加入视频；备注作为旁白，可撤销。`);
        }} /></Suspense></RetainedPane>}
        {visitedPanes.script && <RetainedPane active={scriptView && !designView}><Suspense fallback={<p role="status">正在打开脚本…</p>}><ScriptEditor selectionRequest={boardTarget?.nonce} selectedDocumentId={boardTarget?.kind === "script" ? boardTarget.id : undefined} project={project} active={scriptView && !designView} initialDocuments={documents} externalState={documents} revision={documentVersion} editHandle={scriptEditHandle} onHistoryChange={setScriptHistory} onSelection={setScriptSelection} onDocumentsChange={setDocuments} onBuildScenes={onFork ? buildScript : undefined} /></Suspense></RetainedPane>}
        {visitedPanes.canvas && <RetainedPane active={boardView && !scriptView && !designView}><div aria-label="创意工作区" style={{ position: "relative", minWidth: 0 }}>
            <PreviewBoundary><Suspense fallback={<p role="status" style={{ padding: 12 }}>正在打开创意视图…</p>}>
              <ProjectBoard key={`${project.id}:${designRevision}`} project={project} scripts={documents} designs={designState} onOpenTimeline={onOpenTimeline?()=>{assertAuthoringCanLeave([project.id]);onOpenTimeline(project);}:undefined} onContentChange={boardChange} captureContent={boardSnapshot} onUndoContent={()=>boardHistory()} onRedoContent={()=>boardHistory(true)} canUndoContent={boardPast.length>0} canRedoContent={boardFuture.length>0} onAdoptAsset={name=>{
                assertAuthoringCanLeave([project.id]);
                const next=adoptLibraryVisual(project,scene.id,name,"insert");commit(next);
                setBoardNotice(`已将「${name}」添加为新镜头，可撤销。`);
              }} onOpen={target => {
                try {
                  assertAuthoringCanLeave([project.id]);
                  setBoardTarget({...target,nonce:Date.now()});
                  if(target.kind === "scene") { selectScene(target.id); setBoardView(false); setScriptView(false); setDesignView(false); }
                  if(target.kind === "script") { setVisitedPanes(value=>({...value,script:true})); setScriptView(true); setDesignView(false); }
                  if(target.kind === "design") { setVisitedPanes(value=>({...value,design:true})); setDesignView(true); }
                } catch(cause) { setBoardNotice(cause instanceof Error ? cause.message : "内容未打开，当前草稿保留。"); }
              }} />
              <details><summary>镜头顺序与素材采用</summary>
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
              }} /></details>
            </Suspense></PreviewBoundary>
          </div></RetainedPane>}
          <RetainedPane active={!boardView && !scriptView && !designView}><div aria-label="作品工作区" className="glint-stage-body">
            <Suspense fallback={null}><HybridSceneTools project={project} sceneId={scene.id} onChange={commit} onSelect={selectScene} onInspect={next => { setTab(next); setInspectorOpen(true); if (next === "visual") setVisitedVisual(true); }} /></Suspense>
            {preview && !boardView && !scriptView && !designView ? <>
              <label style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--muted)", fontSize: 12 }}><input type="checkbox" checked={originalView} onChange={event => setOriginalView(event.target.checked)} />对比原画面（仅预览）</label>
              <PreviewBoundary><Suspense fallback={<p role="status" style={{ padding: 12 }}>加载播放器…</p>}>
                <Preview project={originalView ? { ...project, scenes: project.scenes.map(item => ({ ...item, effects: [] })) } : project}
                  selectedSceneId={scene.id} initialFrame={playhead.current ?? posterFrame} onFrameChange={frame => { playhead.current = frame; }} seekRequest={previewSeek} onSeekHandled={handlePreviewSeek} />
              </Suspense></PreviewBoundary>
            </> : <div className="glint-stage-empty"><p style={{ margin: 0 }}>选中的镜头会在这里播放。</p><button type="button" style={button} onClick={() => setPreview(true)}>播放预览</button></div>}
          </div></RetainedPane>
      </section>

      <aside className="glint-editor-inspector" id="glint-inspector" aria-label="镜头属性" data-open={inspectorOpen}>
        <button type="button" className="editor-close-properties" onClick={() => { setInspectorOpen(false); setTab("assistant"); }}>返回画布</button>
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
          {([["content", "内容"], ["visual", "画面"], ["audio", "声音"], ["generate", "生成"], ["assistant", "改稿"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); if (id === "visual") setVisitedVisual(true); }}>{label}</button>)}
          <button type="button" aria-label="查看剧本质量问题" onClick={() => setTab("assistant")} title="剧本结构检查，不检查成片像素" style={{ marginLeft: "auto", color: "var(--muted)" }}>质量检查</button>
        </div>

        <div className="glint-panel" style={{ display: tab === "content" ? "grid" : "none" }}>
          {scene.kind === "chart" && <label>图表类型<select style={field} value={scene.chartType} onChange={event => { const next = structuredClone(project); const target = next.scenes[index]; if (target?.kind === "chart") target.chartType = event.target.value as "bar" | "line"; commit(next); }}><option value="bar">柱状图</option><option value="line">折线图</option></select></label>}
          {editable(scene).filter(item => scene.kind !== "image" || !["presentation", "camera"].includes(String(item.path[0]))).map(({ path, text }) => <label key={path.join(".")}>{path.map(part => typeof part === "number" ? part + 1 : names[part] ?? part).join(" / ")}
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
          {scene.kind === "image" && <section aria-label="图片镜头样式" style={{ display: "grid", gap: 8 }}>
            <label>图片构图<select aria-label="图片构图" style={field} value={scene.presentation ?? "standard"} onChange={event => {
              const next = structuredClone(project), target = next.scenes[index];
              if (target?.kind === "image") { target.presentation = event.target.value === "showcase" ? "showcase" : event.target.value === "slide" ? "slide" : undefined; commit(next); }
            }}><option value="standard">标准图文</option><option value="showcase">产品展示</option><option value="slide">幻灯片 · 完整画面</option></select></label>
            <label>镜头运动<select aria-label="图片镜头运动" style={field} value={!scene.camera || scene.camera.type === "static" ? "static" : ["push", "pull", "pan-left", "pan-right"].includes(scene.camera.type) ? scene.camera.type : "other"} onChange={event => {
              const next = structuredClone(project), target = next.scenes[index];
              if (target?.kind === "image") { const type = event.target.value; target.camera = type === "push" || type === "pull" || type === "pan-left" || type === "pan-right" ? { type, intensity: 0.4 } : { type: "static" }; commit(next); }
            }}><option value="static">静止</option><option value="push">缓慢推进</option><option value="pull">缓慢拉远</option><option value="pan-left">向左平移</option><option value="pan-right">向右平移</option>{scene.camera && !["static", "push", "pull", "pan-left", "pan-right"].includes(scene.camera.type) && <option value="other" disabled>其他运镜（保持原设置）</option>}</select></label>
            {scene.camera && ["push", "pull", "pan-left", "pan-right"].includes(scene.camera.type) && <label>运动强度<input aria-label="图片推进强度" type="range" min="0" max="1" step="0.05" value={scene.camera.intensity ?? 0.5} onChange={event => {
              const next = structuredClone(project), target = next.scenes[index];
              if (target?.kind === "image" && target.camera) { target.camera = { ...target.camera, intensity: Number(event.target.value) }; commit(next); }
            }} /></label>}
            <small style={{ color: "var(--muted)" }}>产品展示使用图片作为柔焦背景，画面说明过长会截断；与旁白完全一致且逐词字幕无差异时只显示字幕。运镜仅作用于产品展示，不增加模型费用。</small>
          </section>}
          <PanelBoundary label="风格工具"><Suspense fallback={<p role="status">正在加载风格与导出工具…</p>}><StylePackPicker project={project} onChange={commit} /></Suspense></PanelBoundary>
          <EffectsPanel project={project} sceneId={scene.id} onChange={commit} />
          <ShapeMorphPanel project={project} sceneId={scene.id} onChange={commit} />
          {visitedVisual && <PanelBoundary label="对象画布"><Suspense fallback={<p role="status">正在加载对象画布…</p>}><ShotCanvas project={project} scene={scene} onSeek={seekPreview} onChange={nextScene => { const next = structuredClone(project); next.scenes[index] = nextScene; commit(next); }} /></Suspense></PanelBoundary>}
        </div>

        <div className="glint-panel" style={{ display: tab === "audio" ? "grid" : "none" }}>
          <label>旁白 / 字幕<textarea aria-label="旁白" rows={4} style={field} value={scene.narration.text} onChange={event => commit(changeNarration(project, index, event.target.value))} /></label>
          <label>旁白偏移 · {scene.narration.audioOffsetMs ?? 0} ms<input aria-label="旁白偏移" type="range" min="-5000" max="5000" step="50" value={scene.narration.audioOffsetMs ?? 0} onChange={event => {
            const next = structuredClone(project); const offset = Number(event.target.value);
            next.scenes[index]!.narration.audioOffsetMs = offset === 0 ? undefined : offset; commit(next);
          }} /></label>
          <small style={{ color: "var(--muted)", lineHeight: 1.6 }}>负值让配音提前进入（J cut），正值延后（L cut）；范围 ±5 秒，只影响这一镜。</small>
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
          {voiceAudio && <><audio aria-label="分镜配音试听" controls src={applicationUrl(voiceAudio)} /><Suspense fallback={null}><VoiceWaveform src={applicationUrl(voiceAudio)} /></Suspense></>}
          {voiceError && <p role="alert" style={{ margin: 0, color: "var(--danger)" }}>{voiceError}</p>}
          <fieldset style={{ display: "grid", gap: 8, margin: 0, padding: 10, border: "1px solid var(--line-2)", borderRadius: 10 }}>
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
              <small style={{ color: "var(--muted)" }}>最多 8 个/镜；成片时叠加在旁白上。</small>
            </div>
          </fieldset>
          {project.music && <label>配乐音量 · {Math.round((project.music.volume ?? 0.12) * 100)}%<input aria-label="配乐音量" type="range" min="0" max="1" step="0.01" value={project.music.volume ?? 0.12} onChange={event => {
            const next = structuredClone(project); next.music = { ...next.music!, volume: Number(event.target.value) }; commit(next);
          }} /></label>}
          <small style={{ color: "var(--muted)", lineHeight: 1.6 }}>Qwen 克隆使用参考录音原速，不支持音色 ID 和变速；ElevenLabs / Fish 语速范围 0.7–1.2×。</small>
        </div>

        <div className="glint-panel" style={{ display: tab === "generate" ? "grid" : "none" }}>
          <PanelBoundary label="角色资产"><Suspense fallback={null}><CharacterIdentityPanel project={project} sceneId={scene.id} onChange={commit} onApprove={onApproveCharacter} canApprove={canApproveCharacter} /></Suspense></PanelBoundary>
          <PanelBoundary label="商品资产"><Suspense fallback={null}><CharacterIdentityPanel kind="product" project={project} sceneId={scene.id} onChange={commit} onApprove={onApproveProduct} canApprove={canApproveProduct} /></Suspense></PanelBoundary>
          <PanelBoundary label="素材工具"><Suspense fallback={<p role="status">正在加载素材工具…</p>}><MediaCandidates project={project} sceneId={scene.id} onChange={next => { commit(next); if (next.scenes.length > project.scenes.length) setSelected(index + 1); }} onSelect={selectScene} /></Suspense></PanelBoundary>
          <PanelBoundary label="生成工具"><Suspense fallback={<p role="status">正在加载生成工具…</p>}><SceneGenerator initialOpen project={project} sceneId={scene.id} onAdoptReferenceCandidate={onAdoptReferenceCandidate} onChange={next => { commit(next); if (next.scenes.length > project.scenes.length) setSelected(index + 1); }} onSelect={selectScene} /></Suspense></PanelBoundary>
        </div>

        <div className="glint-panel" style={{ display: tab === "assistant" ? "grid" : "none" }}>
          <PanelBoundary label="质量检查"><div style={{ display: "grid", gap: 16 }}><DirectorEye project={project} onSelectScene={selectScene} /><Suspense fallback={<p role="status" style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>正在检查剧本结构…</p>}><CraftQuality project={project} onSelectScene={selectScene} /></Suspense></div></PanelBoundary>
        </div>
      </aside>
      </div>
      <aside className="glint-editor-chat" aria-label="项目对话">
        {visitedPanes.design && designState.documents.map(target => <RetainedPane key={`design:${target.id}`} active={designView && target.id === activeDesign?.id}>
          <ArtifactChat projectId={project.id} title={project.title} document={target}
            selection={designSelection?.documentId === target.id && designSelection.nodeId ? designSelection : undefined}
            request={designReview?.projectId === project.id && designReview.documentId === target.id ? designReview : undefined}
            onApply={document => "pages" in document ? applyDesignDocument(target, document) : false} />
        </RetainedPane>)}
        {visitedPanes.script && documents.documents.map(target => <RetainedPane key={`script:${target.id}`} active={scriptView && !designView && target.id === activeScript?.id}>
          <ArtifactChat projectId={project.id} title={project.title} document={target}
            selection={scriptSelection?.documentId === target.id && scriptSelection.end > scriptSelection.start ? scriptSelection : undefined}
            onApply={document => "content" in document ? applyScriptDocument(target, document) : false} />
        </RetainedPane>)}
        <RetainedPane active={!designView && !scriptView}>
          <EditorAssistant project={project} sceneId={scene.id} context={undefined} onChange={next => commit(next, "product-agent")} canvas={{ width: aspectWidth(project.aspect), height: aspectHeight(project.aspect) }} />
        </RetainedPane>
      </aside>
    </div>

    <div className="glint-editor-timeline"><SceneTimelineDock project={project} selectedSceneId={scene.id} onChange={commit} onSelect={id => {
      const position = project.scenes.findIndex(item => item.id === id);
      if (position >= 0) setSelected(position);
      onSelect?.(id);
    }} /></div>
    {gitOpen && <div className="editor-git-layer" role="dialog" aria-modal="true" aria-label="Git 版本管理" onKeyDown={event => { if (event.key === "Escape") setGitOpen(false); }}>
      <button type="button" className="editor-git-backdrop" aria-label="关闭 Git 版本" onClick={() => setGitOpen(false)} />
      <div className="editor-git-panel"><Suspense fallback={<p role="status">正在读取 Git 版本…</p>}>
        <ProjectGitPanel project={project} kind="scene" documents={documents.documents} onClose={() => setGitOpen(false)}
          getWorkspace={() => { if (restoreError) throw new Error(restoreError); return captureProjectWorkspace(project.id, designState); }}
          getStorageSignature={storageSignature}
          onApply={(next, restored, workspace) => "scenes" in next ? applyDocuments(next, restored, workspace) : false}
          onCopy={onFork ? (next, restored, workspace) => "scenes" in next ? copyDocuments(next, restored, workspace) : false : undefined} />
      </Suspense></div>
    </div>}
    <small className="glint-editor-foot">无声预览；字幕按文本估时。导出配音后时长以实际音频为准。{history ? "撤销与 AI 助手、Skill、CLI 共用工程历史。" : "撤销保留最近 30 次修改。"}</small>
  </div>;
}
