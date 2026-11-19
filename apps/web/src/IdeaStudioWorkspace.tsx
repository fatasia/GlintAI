import { TEMPLATES, THEME_IDS } from "@glintai/composer/templates";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { lazy, Suspense } from "react";
import { applicationUrl } from "./app-url";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { AuthoringVisibility } from "./authoring-visibility";
import { downloadJson, downloadText, parseEditorProject } from "./editor-model";
import "./home-workspace.css";
import { terminalJob, type IdeaJob } from "./jobs-client";
import { readSavedProjects, recoverSessionBackup, removeProject, saveProject, type SavedProject, type SessionBackup } from "./project-history";
import type { ProjectRevision } from "./project-revisions";
import { clearRevisions, revisionDelta } from "./project-revisions";
import { ENCODING_OPTIONS, RenderSummary, TTS_ENGINES } from "./RenderSummary";
import { WorkspaceToolbar, WorkspaceTools, type StudioView, type WorkspaceTool } from "./workspace-navigation";
const SessionEditor = lazy(() => import("./SessionEditor").then(module => ({ default: module.SessionEditor })));
const DeliveryCheck = lazy(() => import("./DeliveryCheck").then(module => ({ default: module.DeliveryCheck })));
const ChaptersDisclosure = lazy(() => import("./ChaptersDisclosure").then(module => ({ default: module.ChaptersDisclosure })));
const SourceFileImport = lazy(() => import("./SourceFileImport").then(module => ({ default: module.SourceFileImport })));
const TableFileImport = lazy(() => import("./TableFileImport").then(module => ({ default: module.TableFileImport })));
const ReferenceBuilder = lazy(() => import("./ReferenceBuilder").then(module => ({ default: module.ReferenceBuilder })));
const StylePreviewChooser = lazy(() => import("./StylePackPicker").then(module => ({ default: module.StylePreviewChooser })));
const labels: Record<string, string> = { recovering: "正在查询任务状态", queued: "排队中", compose: "整理资料", rehearse: "虚拟试讲", render: "渲染视频", stopping: "正在停止", done: "已完成", failed: "失败", cancelled: "已取消", interrupted: "任务已中断" };
const themeLabels = ["Glint 深色", "Glint 浅色", "奶油编辑部", "薄荷清爽", "海报大字", "手绘笔记", "复古报刊", "黑板科技", "白板马克笔", "工程蓝图"];


const key = "glint.last-job";
export type WorkspaceProps = {
  editorVersion: number;
  view: StudioView;
  onOpenTimeline: ((sourceId: string) => void) | undefined;
  storageRecoveryBlocked: boolean;
  receiveSessionProject: (next: SceneScriptProject) => void;
  registerGitProject: (value: SceneScriptProject, context: { mode: "source" | "idea"; text: string; template: string; theme: string; evidence?: string }, automatic: boolean) => void;

  tool: WorkspaceTool | null;
  openTool: (next: WorkspaceTool) => void;
  setTool: Dispatch<SetStateAction<WorkspaceTool | null>>;
  error: string;
  revisions: ProjectRevision[];
  restoreFromRevision: (revision: ProjectRevision) => void;
  branchFromRevision: (revision: ProjectRevision) => void;
  busy: boolean;
  composing: boolean;
  submitting: boolean;
  text: string;
  project: SceneScriptProject | null;
  rememberProject: () => void;
  setMode: Dispatch<SetStateAction<"source" | "idea">>;
  setText: Dispatch<SetStateAction<string>>;
  setProject: Dispatch<SetStateAction<SceneScriptProject | null>>;
  setReview: Dispatch<SetStateAction<ReturnType<typeof import("@glintai/composer").reviewProject> | null>>;
  importRef: RefObject<HTMLInputElement | null>;
  loadProjectDocument: (value: unknown) => boolean;
  setError: Dispatch<SetStateAction<string>>;
  storageStatus: string;
  setBackupSelection: Dispatch<SetStateAction<string | null>>;
  refreshSessionBackups: () => void;
  backupNotice: string;
  sessionBackups: SessionBackup[];
  setBackupNotice: Dispatch<SetStateAction<string>>;
  backupRecovering: boolean;
  backupSelection: string | null;
  recoveryLock: RefObject<boolean>;
  setBackupRecovering: Dispatch<SetStateAction<boolean>>;
  mounted: RefObject<boolean>;
  setProjects: Dispatch<SetStateAction<SavedProject[]>>;
  loadSharedProjects: () => Promise<void>;
  sharedMessage: string;
  sharedProjects: { projectId: string; title: string; revision: number; }[];
  projectId: string | null;
  openSharedProject: (id: string) => Promise<void>;
  projects: SavedProject[];
  restoreProject: (saved: SavedProject) => void;
  refreshRevisions: (id?: string | null) => void;
  visited: { plan: boolean; templates: boolean; create: boolean; reference: boolean; };
  mode: "source" | "idea";
  setEvidence: Dispatch<SetStateAction<string>>;
  aspect: string;
  template: string;
  setTemplate: Dispatch<SetStateAction<string>>;
  selectorTheme: string;
  setTheme: Dispatch<SetStateAction<string>>;
  setAspect: Dispatch<SetStateAction<string>>;
  themeWarning: string | undefined;
  engine: string;
  setEngine: Dispatch<SetStateAction<string>>;
  compose: () => Promise<void>;
  editorProject: SceneScriptProject | null;
  lock: RefObject<boolean>;
  syncProjectTheme: (next: SceneScriptProject, fallback?: string) => void;
  setEditorVersion: Dispatch<SetStateAction<number>>;
  setProjectId: Dispatch<SetStateAction<string | null>>;
  setStorageStatus: Dispatch<SetStateAction<string>>;
  navigate: (next: StudioView) => void;
  evidence: string;
  recheck: () => Promise<void>;
  review: ReturnType<typeof import("@glintai/composer").reviewProject> | null;
  tts: string;
  setTts: Dispatch<SetStateAction<string>>;
  voiceEngines: string[];
  music: string;
  refreshMusic: () => Promise<void>;
  setMusic: Dispatch<SetStateAction<string>>;
  musicAssets: { name: string; }[];
  encoding: string;
  setEncoding: Dispatch<SetStateAction<string>>;
  costConfirmed: boolean;
  setCostConfirmedKey: Dispatch<SetStateAction<string>>;
  preflightKey: string;
  costBlocked: boolean;
  submit: () => Promise<void>;
  job: IdeaJob | null;
  cancel: () => Promise<void>;
  recoveryRequest: string | null;
  setRecoveryRequest: Dispatch<SetStateAction<string | null>>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  paused: boolean;
  setRetry: Dispatch<SetStateAction<number>>;
  setJob: Dispatch<SetStateAction<IdeaJob | null>>;
  submission: RefObject<{ signature: string; requestId: string; } | null>;
  theme: string;
};

export default function IdeaStudioWorkspace({ tool, openTool, setTool, error, revisions, restoreFromRevision, branchFromRevision, busy, composing, submitting, text, project, rememberProject, setMode, setText, setProject, setReview, importRef, loadProjectDocument, setError, storageStatus, setBackupSelection, refreshSessionBackups, backupNotice, sessionBackups, setBackupNotice, backupRecovering, backupSelection, recoveryLock, setBackupRecovering, mounted, setProjects, loadSharedProjects, sharedMessage, sharedProjects, projectId, openSharedProject, projects, restoreProject, refreshRevisions, visited, mode, setEvidence, aspect, template, setTemplate, selectorTheme, setTheme, setAspect, themeWarning, engine, setEngine, compose, editorProject, lock, syncProjectTheme, setEditorVersion, setProjectId, setStorageStatus, navigate, evidence, recheck, review, tts, setTts, voiceEngines, music, refreshMusic, setMusic, musicAssets, encoding, setEncoding, costConfirmed, setCostConfirmedKey, preflightKey, costBlocked, submit, job, cancel, recoveryRequest, setRecoveryRequest, setPaused, paused, setRetry, setJob, submission, theme, editorVersion, view, onOpenTimeline, storageRecoveryBlocked, receiveSessionProject, registerGitProject }: WorkspaceProps) {
  return (<>
    <section className="studio-workspace" aria-label="工程工作区" hidden={view !== "workspace"}>
      <WorkspaceToolbar title={project?.title || "新建工程"} hasProject={Boolean(project)} onBack={() => navigate("home")} onPlan={() => navigate("plan")} tool={tool} onTool={openTool} onSave={rememberProject} disabled={busy || submitting || composing} status={storageStatus} />
      <fieldset disabled={busy || composing || submitting} className="workspace-editor">
      {editorProject && !themeWarning && <AuthoringVisibility active={view === "workspace"}><Suspense fallback={<p role="status">正在打开工程…</p>}><SessionEditor key={`${editorProject.id}-${editorVersion}`} project={editorProject} voiceEngine={tts} onOpenTimeline={onOpenTimeline ? value=>{
        assertAuthoringCanLeave([value.id]);
        if(storageRecoveryBlocked)throw new Error("本机恢复尚未完成，请先核对记录。");
        const saved=saveProject({id:projectId??crypto.randomUUID(),name:value.title,mode,text,template,theme,aspect:value.aspect,project:value,evidence});
        setProjectId(saved.id);setProjects(readSavedProjects());onOpenTimeline(saved.id);
      }:undefined} onChange={receiveSessionProject} onFork={value => { setProjectId(null); receiveSessionProject(value); setEditorVersion(version => version + 1); }} onGitAccepted={value => registerGitProject(value, { mode, text, template, theme, evidence }, true)} /></Suspense></AuthoringVisibility>}
      {editorProject && themeWarning && <p role="status" className="studio-note">为避免预览使用错误风格，编辑器与预览暂不可用；原工程可保存或导出，选择可用风格后继续编辑。 <button type="button" className="g-btn g-btn--sm" onClick={() => downloadJson("glint-project.json", editorProject)}>导出原工程 JSON</button></p>}
      </fieldset>
      {!editorProject && <div className="workspace-empty"><h2>从这里开始一支作品</h2><p>打开已有工程，或先确认方案。生成后会直接进入编辑区。</p><div><button className="g-btn g-btn--primary" onClick={() => openTool("create")}>使用资料生成</button><button className="g-btn" onClick={() => openTool("imports")}>打开工程</button><button className="g-btn g-btn--quiet" onClick={() => navigate("plan")}>先看方案</button></div></div>}
    </section>
    <WorkspaceTools tool={tool} onTool={openTool} onClose={() => setTool(null)}>
      {error && <p role="alert" className="studio-error">{error}</p>}
      <section aria-label="历史版本" hidden={tool !== "history"}>
      <p className="ws-note">手动保存与生成分镜会自动留档。恢复只载入编辑区，不覆盖已保存工程；分支会创建独立作品。</p>
      {revisions.length ? <div className="revision-list">{revisions.slice(0, 10).map((revision, index) => {
        const delta = revisionDelta(revisions[index + 1], revision.snapshot);
        const reason = { manual: "手动保存", generated: "生成分镜", restore: "恢复", branch: "分支" }[revision.reason];
        return <div className="revision-item" key={revision.id}>
          <span className="revision-meta"><strong>{revision.label}</strong><small>{revision.label === reason ? "" : `${reason} · `}{new Date(revision.at).toLocaleString("zh-CN")} · {delta.scenes} 镜{delta.changed.length ? ` · ${delta.changed.join(" / ")}` : ""}</small></span>
          <span className="revision-actions"><button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => restoreFromRevision(revision)}>恢复</button><button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => branchFromRevision(revision)}>分支</button></span>
        </div>;
      })}</div> : <p className="ws-note">还没有版本。按 Ctrl/Cmd+S 或点「保存项目」开始留档。</p>}
        <button type="button" className="g-btn g-btn--primary ws-submit" disabled={busy || composing || submitting || (!text.trim() && !project)} onClick={rememberProject}>保存项目</button>
      </section>
      <section aria-label="工程与备份" hidden={tool !== "imports"}>
    <div className="ws-actions">
      <button type="button" className="g-btn" disabled={busy || composing || submitting} onClick={() => { setMode("source"); setText("# 清晰的讲解\n\n## 从问题开始\n先说清楚要解决什么问题。\n\n## 给出例子\n展示一个可以重复的操作，再解释结果和限制。"); setProject(null); setReview(null); }}>载入入门示例</button>
      <button type="button" className="g-btn" disabled={busy || composing || submitting} onClick={() => importRef.current?.click()}>导入项目 JSON</button>
      <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 100000) throw new Error("项目文件超过 100 KB"); loadProjectDocument(JSON.parse(await file.text())); } catch (err) { setError(err instanceof Error ? err.message : "导入失败"); } finally { if (importRef.current) importRef.current.value = ""; } }} />
      <span role="status" className="ws-note">{storageStatus}</span>
    </div>
    <details className="ws-details" onToggle={event => { if (event.currentTarget.open) { setBackupSelection(null); refreshSessionBackups(); } }}>
      <summary>本机冲突备份 · 恢复或导出</summary>
      <p className="ws-note">备份仅保存在此浏览器。恢复会在本地服务创建独立共享工程并保存为作品，不切换或覆盖当前草稿；角色和商品须重新批准，素材文件需另行备份。</p>
      <p role="status" className="ws-note">{backupNotice}</p>
      {!sessionBackups.length && !backupNotice && <p className="ws-note">没有本机冲突备份。</p>}
      <div className="ws-list">
        {sessionBackups.map(backup => <div key={backup.key} className="ws-row">
          <div className="ws-row-title"><strong>{backup.title}</strong> · <code className="ws-code">{backup.projectId}</code> · {backup.createdAt ? new Date(backup.createdAt).toLocaleString("zh-CN") : "时间未知"}{!backup.valid && " · 无法恢复，可导出原文件"}</div>
          <div className="ws-actions">
            <button type="button" className="g-btn g-btn--sm" onClick={() => {
              try { const raw = localStorage.getItem(backup.key); if (raw === null) throw new Error("备份已不存在，请刷新列表。"); downloadText("glint-session-backup.json", raw, "application/json;charset=utf-8"); setBackupNotice("已发起备份文件下载；素材文件未包含在内。"); }
              catch { setBackupNotice("导出失败，请检查浏览器存储和下载权限。"); }
            }}>导出备份</button>
            {backup.valid && <button type="button" className="g-btn g-btn--sm" disabled={backupRecovering} onClick={() => { setBackupSelection(backup.key); setBackupNotice(""); }}>恢复为独立作品</button>}
          </div>
          {backupSelection === backup.key && <div role="group" aria-label="确认恢复备份" className="ws-confirm">
            <p className="ws-note">确认创建独立作品？当前草稿和原备份不会被替换；批准状态与冻结状态会清除。</p>
            <div className="ws-actions">
            <button type="button" className="g-btn g-btn--sm g-btn--primary" disabled={backupRecovering} onClick={async () => {
              if (recoveryLock.current) return;
              recoveryLock.current = true; setBackupRecovering(true); setBackupNotice("正在安全创建共享副本，请稍候。");
              try { const saved = await recoverSessionBackup(backup.key); if (mounted.current) { setProjects(readSavedProjects()); setBackupSelection(null); setBackupNotice(`已恢复为独立作品「${saved.name}」，当前草稿未改变。`); } }
              catch (error) { if (mounted.current) setBackupNotice(error instanceof Error ? `恢复失败：${error.message}` : "恢复失败，请先导出备份。"); }
              finally { recoveryLock.current = false; if (mounted.current) setBackupRecovering(false); }
            }}>{backupRecovering ? "正在恢复…" : "确认恢复"}</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" disabled={backupRecovering} onClick={() => { setBackupSelection(null); setBackupNotice("已取消恢复，当前草稿未改变。"); }}>取消恢复</button>
            </div>
          </div>}
        </div>)}
      </div>
    </details>
    <details className="ws-details" onToggle={event => { if (event.currentTarget.open) void loadSharedProjects(); }}>
      <summary>从 Skill / CLI 继续</summary>
      <p role="status" className="ws-note">{sharedMessage}</p>
      <div className="ws-list">{sharedProjects.map(item => <button type="button" key={item.projectId} className="ws-pick" disabled={busy || composing || submitting} onClick={() => void openSharedProject(item.projectId)}>{item.title || item.projectId} · r{item.revision}<small>{item.projectId}</small></button>)}</div>
    </details>
    {projects.length > 0 && <details className="ws-details">
      <summary>全部作品与删除</summary>
      <div className="ws-list">
        {projects.map((project) => <div key={project.id} className="ws-item">
          <button type="button" className="ws-pick" onClick={() => restoreProject(project)}>{project.name}<small>{new Date(project.updatedAt).toLocaleString()}</small></button>
          <button type="button" className="g-btn g-btn--sm g-btn--quiet" aria-label={`删除 ${project.name}`} onClick={() => { try { removeProject(project.id); clearRevisions(project.id); setProjects(readSavedProjects()); refreshRevisions(); } catch { setError("删除失败：本机存储不可用"); } }}>删除</button>
        </div>)}
      </div>
    </details>}
      </section>
      <section aria-label="参考片工具" hidden={tool !== "reference"}>
        {visited.reference && <Suspense fallback={<p role="status">正在加载参考片工具…</p>}><ReferenceBuilder onProject={value => {
          const loaded = loadProjectDocument(value);
          // Keep the review open while adopting OCR edits, cuts and refreshed frames.
          if (loaded) setTool("reference");
          return loaded;
        }} currentProject={project} disabled={busy || submitting || composing} /></Suspense>}
      </section>
      <section aria-label="创作参数" hidden={tool !== "create"}>
    <fieldset disabled={busy || submitting || composing} className="ws-group">
      <legend className="g-label">资料与想法</legend>
      <div className="g-seg" role="group" aria-label="输入类型">
        <button type="button" aria-pressed={mode === "source"} onClick={() => { setMode("source"); setText(""); setProject(null); setReview(null); }}>已有资料</button>
        <button type="button" aria-pressed={mode === "idea"} onClick={() => { setMode("idea"); setText(""); setProject(null); setReview(null); }}>一句话想法</button>
      </div>
      <label className="ws-label" htmlFor="make-input">{mode === "source" ? "粘贴 Markdown 或正文（最多 12000 字）" : "描述讲解主题（最多 2000 字）"}</label>
      <textarea id="make-input" className="g-field ws-textarea" aria-label="创作资料" maxLength={mode === "source" ? 12000 : 2000} rows={5} value={text} onChange={(event) => { setText(event.target.value); setProject(null); setReview(null); }} placeholder={mode === "source" ? "# 标题\n\n## 核心概念\n资料正文…" : "例如：用扑克牌解释熵"} />
      {visited.create && mode === "source" && <Suspense fallback={null}><SourceFileImport replacesProject={Boolean(project)} onApply={value => { setText(value); setProject(null); setReview(null); setEvidence(""); setError(""); }} /></Suspense>}
      {visited.create && mode === "source" && <Suspense fallback={null}><TableFileImport aspect={aspect as SceneScriptProject["aspect"]} replacesProject={Boolean(project)} onProject={(value, source) => { const loaded = loadProjectDocument(value); if (loaded) { setText(source); setEvidence(source); } return loaded; }} /></Suspense>}
    </fieldset>
    <fieldset disabled={busy || submitting || composing} className="ws-group">
      <legend className="g-label">版式与风格</legend>
      <div className="ws-grid">
        <label className="ws-form-row">版式<select className="g-field" value={template} onChange={(e) => { setTemplate(e.target.value); setProject(null); setReview(null); }}>{TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="ws-form-row">风格<select className="g-field" aria-label="风格" value={selectorTheme} onChange={(e) => {
          const next = e.target.value;
          if (!next) return;
          if (project?.theme && typeof project.theme === "object" && !window.confirm("更换风格会替换工程中保存的风格参数或快照，原快照将不再保留。是否继续？")) return;
          setTheme(next); setProject(current => current ? { ...current, theme: next } : null); setError("");
        }}>{!selectorTheme && <option value="" disabled>当前工程使用自定义或未知风格</option>}{THEME_IDS.map((id, i) => <option key={id} value={id}>{themeLabels[i] ?? id}</option>)}</select></label>
        <label className="ws-form-row">画幅<select className="g-field" aria-label="工程画幅" value={aspect} onChange={(e) => setAspect(e.target.value)}>{["16:9", "9:16", "1:1"].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      {themeWarning && <p role="alert" className="studio-error">{themeWarning}</p>}
      <details className="ws-details"><summary>浏览风格样片</summary><Suspense fallback={<p role="status" className="ws-note">正在加载风格目录…</p>}><StylePreviewChooser current={selectorTheme} onApply={next => {
        if (project?.theme && typeof project.theme === "object" && !window.confirm("更换风格会替换工程中保存的风格参数或快照，原快照将不再保留。是否继续？")) return;
        setTheme(next); setProject(current => current ? { ...current, theme: next } : null); setError("");
      }} /></Suspense></details>
      <label className="ws-form-row">生成方式<select className="g-field" value={engine} onChange={event => setEngine(event.target.value)}><option value="heuristic">本地生成 · 不联网</option><option value="llm">模型生成 · 需要配置</option></select></label>
      <p className="ws-note">{TEMPLATES.find((item) => item.id === template)?.description} 资料要求：{TEMPLATES.find((item) => item.id === template)?.requires}。</p>
    </fieldset>
    <fieldset disabled={busy || composing || submitting} className="ws-group">
      <button type="button" className="g-btn g-btn--primary ws-submit" disabled={!text.trim() || composing || busy} onClick={() => void compose()}>{composing ? "正在编排…" : project ? "重新生成（替换当前分镜）" : "生成分镜"}</button>
      <Suspense fallback={<p role="status">正在加载章节…</p>}><ChaptersDisclosure project={editorProject} context={{ mode, text, template, theme, evidence }} disabled={busy || composing || submitting} onOpen={chapter => {
        if (busy || composing || submitting || lock.current) return false;
        const next = parseEditorProject(chapter.project);
        assertAuthoringCanLeave([next.id, ...(project ? [project.id] : [])]);
        if (editorProject) {
          try { saveProject({ id: projectId ?? crypto.randomUUID(), name: editorProject.title, mode, text, template, theme, aspect: editorProject.aspect, project: editorProject, evidence }); setProjects(readSavedProjects()); }
          catch { throw new Error("当前工程备份失败；请先导出项目 JSON，再切换章节。编辑区未替换。"); }
        }
        setProject(next); setMode(chapter.context.mode); setText(chapter.context.text); setTemplate(chapter.context.template);
        syncProjectTheme(next, chapter.context.theme); setAspect(next.aspect); setEvidence(chapter.context.evidence);
        setEditorVersion(version => version + 1); setProjectId(null); setReview(null); setError("");
        setStorageStatus(`已载入章节「${chapter.title}」，编辑修改需手动更新章节快照`);
        navigate("workspace");
        return true;
      }} /></Suspense>
      {project && <button type="button" className="g-btn g-btn--quiet ws-submit" disabled={!evidence} onClick={() => void recheck()}>重新核对旁白依据</button>}
      {review && <details className="ws-details"><summary>旁白依据核对 · {review.flagged}/{review.sentences.length} 句待看</summary><p className="ws-note">{review.basis}</p>{review.sentences.filter((sentence) => sentence.flags.length).map((sentence, i) => <div key={i} className="ws-row"><strong>{sentence.sceneId}</strong><p>{sentence.text}</p><small>{sentence.flags.join(" / ")}</small>{sentence.candidates[0] && <blockquote className="ws-quote">资料候选：{sentence.candidates[0].text}</blockquote>}</div>)}</details>}
    </fieldset>
      </section>
      <section aria-label="配音与导出" hidden={tool !== "export"}>
    <div className="ws-group">
      <p className="g-label">配音、配乐与导出</p>
      <p className="ws-note">分镜优先于输入资料；改写资料或版式后请重新生成。Edge 配音联网，系统音色仅支持 Windows，本地克隆使用服务端参考音频。</p>
      <div className="ws-grid">
        <label className="ws-form-row">配音<select className="g-field" aria-label="配音" value={tts} onChange={event => setTts(event.target.value)} disabled={busy || submitting}>{TTS_ENGINES.map(item => <option key={item.id} value={item.id} disabled={!voiceEngines.includes(item.id)}>{item.label}{voiceEngines.includes(item.id) ? "" : " · 未配置"}</option>)}</select></label>
        <label className="ws-form-row">背景配乐<select className="g-field" aria-label="背景配乐" value={music} onFocus={() => void refreshMusic()} onChange={event => setMusic(event.target.value)} disabled={busy || submitting}><option value="off">无配乐</option><option value="auto">本地氛围音 · 不联网</option>{musicAssets.map(asset => <option key={asset.name} value={asset.name}>{asset.name}</option>)}</select><small>在素材工坊生成 Suno / MiniMax 音乐后，回到这里选择；复用素材不会重新生成。</small></label>
        <label className="ws-form-row">导出规格<select className="g-field" aria-label="导出规格" value={encoding} onChange={event => setEncoding(event.target.value)} disabled={busy || submitting}>{ENCODING_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <RenderSummary project={project} tts={tts} encoding={encoding} confirmed={costConfirmed} disabled={busy || submitting || composing} onConfirmationChange={checked => setCostConfirmedKey(checked ? preflightKey : "")} />
      <div className="ws-actions">
        <button type="button" className="g-btn g-btn--primary" disabled={busy || submitting || composing || (!text.trim() && !project) || costBlocked} title={costBlocked ? "请先勾选“我确认可能产生费用”" : undefined} onClick={() => void submit()}>{submitting ? "提交中…" : busy ? "导出中…" : project ? "导出 MP4" : "生成草稿"}</button>
        <button type="button" className="g-btn" disabled={busy || submitting || composing || (!text.trim() && !project)} onClick={rememberProject}>保存项目</button>
        {busy && job && <button className="g-btn g-btn--quiet" disabled={job.status === "cancelling"} onClick={() => void cancel()}>取消任务</button>}
        {recoveryRequest && <button className="g-btn g-btn--quiet" onClick={()=>{setRecoveryRequest(null);setPaused(false);setError("已停止查询；服务器任务未取消。");try{localStorage.removeItem(`${key}:request`);}catch{}}}>停止查询</button>}
        {paused && <button className="g-btn g-btn--quiet" onClick={() => { setPaused(false); setRetry((value) => value + 1); }}>恢复查询</button>}
        {job && terminalJob(job) && <button className="g-btn g-btn--quiet" onClick={() => { setJob(null); setError(""); submission.current = null; try { localStorage.removeItem(key); } catch {} }}>清除任务记录</button>}
      </div>
      {job && job.log.length > 0 && <details className="ws-details"><summary>任务进度</summary><ol className="ws-log">{job.log.map((line, i) => <li key={i}>{labels[line] ?? "处理中"}</li>)}</ol></details>}
      {job?.status === "done" && job.video && <><video className="ws-video" aria-label="生成的视频" src={applicationUrl(job.video)} controls preload="metadata" /><a className="ws-link" href={applicationUrl(`${job.video}?download=1`)} download>下载 MP4</a><Suspense fallback={<p role="status">载入成片检查…</p>}><DeliveryCheck jobId={job.id} /></Suspense>{(() => {
        // Rendered length follows the real TTS audio; when it drifts from the
        // approved storyboard budget, say so instead of silently shipping it.
        if (!job.duration || !project) return null;
        const budgetSeconds = buildTimeline(project).totalMs / 1000;
        const drift = Math.round((job.duration - budgetSeconds) * 10) / 10;
        if (Math.abs(drift) < 0.5) return null;
        return <p role="status" className="ws-note ws-note--warn">配音让成片比批准时长{drift > 0 ? "长" : "短"} {Math.abs(drift).toFixed(1)} 秒（预算 {budgetSeconds.toFixed(1)}s · 实际 {job.duration.toFixed(1)}s）。可精简口播文案、换配音引擎，或接受当前节奏。</p>;
      })()}</>}
    </div>
      </section>
    </WorkspaceTools>
  </>);
}
