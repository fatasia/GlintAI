import { TEMPLATES, THEME_IDS } from "@glintai/composer/templates";
import { type SceneScriptProject } from "@glintai/scenescript";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { appFetch as fetch } from "./app-url";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { downloadJson, parseEditorProject } from "./editor-model";
import type { LocalGitSelection } from "./git-local-works";
import "./home-workspace.css";
import { HomeHero } from "./HomeHero";
import { loadLocalGitVersion, recoverStudioWorkspace } from "./IdeaStudioStorage";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { prepareGitProjectRegistration, readSavedProjects, readSavedProjectsStrict, readSessionBackups, saveProject, type SavedProject, type SessionBackup } from "./project-history";
import { branchRevision, readRevisions, recordRevision, restoreRevision, type ProjectRevision } from "./project-revisions";
import { assertGitStorageReady, assertLocalWorkspaceCurrent, readGitProject, readWorkspace, sameGitProject, saveLocalWorkspace } from "./project-workspace-storage";
import type { ComposeContext, ComposedWork } from "./ProjectComposer";
import type { QuickVideoPreset } from "./QuickVideo";
import { ttsCost } from "./tts-cost";
import { useStudioRoute, type StudioLocation, type StudioRequest } from "./shell/use-studio-route";
import { readStyleSnapshot } from "./style-snapshot";
import { type StudioView, type WorkspaceTool } from "./workspace-navigation";
const LocalGitWorks = lazy(() => import("./LocalGitWorks").then(module => ({ default: module.LocalGitWorks })));
const IdeaStudioViews = lazy(() => import("./IdeaStudioViews"));
const IdeaStudioWorkspace = lazy(() => import("./IdeaStudioWorkspace"));
const labels: Record<string, string> = { recovering: "正在查询任务状态", queued: "排队中", compose: "整理资料", rehearse: "虚拟试讲", render: "渲染视频", stopping: "正在停止", done: "已完成", failed: "失败", cancelled: "已取消", interrupted: "任务已中断" };

function themeForSelector(value: SceneScriptProject["theme"]): string | undefined {
  const name = typeof value === "string" ? value : readStyleSnapshot(value)?.name;
  return name && (THEME_IDS as readonly string[]).includes(name) ? name : undefined;
}
function unsupportedTheme(value: SceneScriptProject["theme"]): string | undefined {
  if (typeof value === "string" && !themeForSelector(value)) return `工程使用未知风格「${value}」；原始主题已保留，生成前请选择可用风格。`;
  if (value && typeof value === "object" && Object.hasOwn(value, "glintStyleSnapshot") && !readStyleSnapshot(value)) return "工程包含无法识别的风格快照版本或格式；原始快照已保留，生成前请确认并更换风格。";
  return undefined;
}
const key = "glint.last-job";
export function IdeaStudio({ cardStyle, onViewChange, onOpenSettings, onOpenTimeline, location, onLocationChange }: { cardStyle: CSSProperties; onViewChange?(view: StudioView): void; onOpenSettings?(): void; onOpenTimeline?(sourceId:string):void; location?: StudioRequest; onLocationChange?(location: StudioLocation): void }) {
  const [view, setView] = useState<StudioView>("home");
  const [workspaceToolsVisited, setWorkspaceToolsVisited] = useState(false);
  const [tool, setTool] = useState<WorkspaceTool | null>(null);
  const [visited, setVisited] = useState({ plan: false, templates: false, create: false, reference: false });
  const navigate = (next: StudioView) => {
    setView(next); setTool(null);
    if (next === "plan" || next === "templates") setVisited(current => ({ ...current, [next]: true }));
  };
  const openTool = (next: WorkspaceTool) => {
    setWorkspaceToolsVisited(true);
    setView("workspace"); setTool(next);
    if (next === "create" || next === "reference") setVisited(current => ({ ...current, [next]: true }));
    if (next === "history") refreshRevisions();
  };
  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);
  const [mode, setMode] = useState<"source" | "idea">("source");
  const [text, setText] = useState("");
  const [template, setTemplate] = useState("explainer");
  const [theme, setTheme] = useState("glint-dark");
  const [aspect, setAspect] = useState("16:9");
  const [job, setJob] = useState<IdeaJob | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recoveryRequest, setRecoveryRequest] = useState<string | null>(null);
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [sessionBackups, setSessionBackups] = useState<SessionBackup[]>([]);
  const [backupNotice, setBackupNotice] = useState("");
  const [backupSelection, setBackupSelection] = useState<string | null>(null);
  const [backupRecovering, setBackupRecovering] = useState(false);
  const recoveryLock = useRef(false);
  const refreshSessionBackups = () => {
    try { setSessionBackups(readSessionBackups()); setBackupNotice(""); }
    catch { setBackupNotice("无法读取本机备份，请检查浏览器存储权限。"); }
  };
  const [revisions, setRevisions] = useState<ProjectRevision[]>([]);
  const [recipePreset, setRecipePreset] = useState<QuickVideoPreset | undefined>(undefined);
  const [sharedProjects, setSharedProjects] = useState<Array<{ projectId: string; title: string; revision: number }>>([]);
  const [sharedMessage, setSharedMessage] = useState("");
  const loadSharedProjects = async () => {
    try { const response = await fetch("/api/session/list"); const value = await response.json(); if (!response.ok) throw new Error(value.error); setSharedProjects(value.projects ?? []); setSharedMessage(value.projects?.length ? "选择工程，接续 Skill / CLI 的修改" : "还没有共享工程。可从 Skill 创建，或在此生成分镜。"); }
    catch { setSharedMessage("共享工程列表不可用，请检查本地服务。"); }
  };
  const openSharedProject = async (id: string) => {
    try {
      const input = registrationInput.current, signature = JSON.stringify(input);
      const guarded = [id, ...(input.project ? [input.project.id] : [])];
      assertAuthoringCanLeave(guarded);
      const response = await fetch(`/api/session/snapshot?projectId=${encodeURIComponent(id)}`); const value = await response.json(); if (!response.ok) throw new Error(value.error);
      const next = parseEditorProject(value.snapshot.document);
      if (JSON.stringify(registrationInput.current) !== signature) throw new Error("读取共享工程期间当前输入发生变化，未替换编辑区。");
      assertAuthoringCanLeave(guarded);
      setProject(next); syncProjectTheme(next); setAspect(next.aspect); setEditorVersion(value => value + 1); setProjectId(null); setReview(null); setEvidence(""); setError(""); navigate("workspace");
    } catch (error) { setError(error instanceof Error ? error.message : "打开共享工程失败"); }
  };
  const [project, setProject] = useState<SceneScriptProject | null>(null);
  const [review, setReview] = useState<ReturnType<typeof import("@glintai/composer").reviewProject> | null>(null);
  const [evidence, setEvidence] = useState("");
  const currentReviewInput = useRef({ project, evidence }); currentReviewInput.current = { project, evidence };
  const [composing, setComposing] = useState(false);
  const [engine, setEngine] = useState("heuristic");
  const [tts, setTts] = useState("mock");
  const [voiceEngines, setVoiceEngines] = useState<string[]>(["mock"]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/health", { signal: controller.signal }).then(response => response.json()).then(value => { if (Array.isArray(value.voices)) setVoiceEngines(value.voices); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [encoding, setEncoding] = useState("draft");
  // Confirmation is bound to the exact engine, export profile and project content that
  // produced it, so polling or unrelated state updates cannot silently keep it alive.
  const projectSignature = useMemo(() => project ? JSON.stringify(project) : "", [project]);
  const preflightKey = `${tts}\u0000${encoding}\u0000${projectSignature}`;
  const [costConfirmedKey, setCostConfirmedKey] = useState("");
  useEffect(() => { setCostConfirmedKey(""); }, [preflightKey]);
  const cost = ttsCost(tts);
  const costConfirmed = costConfirmedKey === preflightKey;
  const costBlocked = cost.requiresConfirmation && !costConfirmed;
  const [music, setMusic] = useState("off");
  const [musicAssets, setMusicAssets] = useState<{ name: string }[]>([]);
  const refreshMusic = async () => {
    try { const response = await fetch("/api/media/library"); const data = await response.json(); if (response.ok && Array.isArray(data.assets)) setMusicAssets(data.assets.filter((asset: { name: string }) => /\.(mp3|wav)$/.test(asset.name))); } catch { /* Optional media library. */ }
  };
  useEffect(() => { void refreshMusic(); }, []);
  const [storageStatus, setStorageStatus] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const workspaceBaseline = useRef<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [storageRecoveryBlocked, setStorageRecoveryBlocked] = useState(false);
  const [gitRegistration, setGitRegistration] = useState<SceneScriptProject | null>(null);
  const [gitNotice, setGitNotice] = useState("");
  const [gitWorksOpen, setGitWorksOpen] = useState(false);
  const discoveredGit = useRef<LocalGitSelection | null>(null);
  const [gitSourceNotice, setGitSourceNotice] = useState("");
  const registrationInput = useRef({ project, aspect, mode, text, template, theme, evidence });
  registrationInput.current = { project, aspect, mode, text, template, theme, evidence };
  const [projectId, setProjectId] = useState<string | null>(null);
  const registerGitProject = (value: SceneScriptProject, context: { mode: "source" | "idea"; text: string; template: string; theme: string; evidence?: string }, automatic: boolean) => {
    setGitRegistration(value);
    try {
      assertGitStorageReady(value.id);
      const stored = readGitProject(value.id);
      if (!stored || !sameGitProject(stored, value)) throw new Error("完整本机版本已变化，未登记过期工程；请先导出并核对。");
      void import("./git-local-works").then(module => module.rememberLocalGitSource(value, context)).catch(cause => {
        if (mounted.current) setGitSourceNotice(cause instanceof Error ? cause.message : "原资料记录未保存；本机主快照仍可找回。");
      });
      const registration = prepareGitProjectRegistration(value, context);
      if ((!automatic && !registration.existing) || registration.requiresConfirmation) {
        setGitNotice(registration.requiresConfirmation ? "完整本机版本与作品列表不同；确认后仅更新该作品入口，不更改 Git 历史。" : "已找到当前完整本机工程；可登记到作品列表，未自动恢复已删除的入口。");
        return;
      }
      const saved = registration.commit();
      setProjectId(saved.id); setProjects(readSavedProjectsStrict()); setGitRegistration(null);
      setGitNotice("完整本机版本已登记到作品列表；共享服务端保存状态请查看工程同步栏。");
    } catch (cause) { setGitNotice(`完整本机版本仍保留；作品列表登记未完成：${cause instanceof Error ? cause.message : "请检查本机存储权限。"}`); }
  };
  const retryGitRegistration = () => {
    if (!gitRegistration) return;
    try {
      const input = registrationInput.current;
      const verify = () => {
        assertGitStorageReady(gitRegistration.id);
        assertLocalWorkspaceCurrent(workspaceBaseline.current);
        const current = registrationInput.current;
        if (current !== input || !current.project || !sameGitProject({ ...current.project, aspect: current.aspect as SceneScriptProject["aspect"] }, gitRegistration))
          throw new Error("编辑区已产生新修改；请先保存或导出当前草稿，未登记旧版本。");
        const stored = readGitProject(gitRegistration.id);
        if (!stored || !sameGitProject(stored, gitRegistration)) throw new Error("完整本机版本已变化，请先核对。");
      };
      verify();
      const registration = prepareGitProjectRegistration(gitRegistration, { mode: input.mode, text: input.text, template: input.template, theme: input.theme, evidence: input.evidence });
      if (registration.requiresConfirmation && !window.confirm("将作品列表中的该工程入口更新为当前完整本机版本？其他作品和 Git 历史不会更改。")) return;
      // A confirmation dialog does not lock storage or React state in this or another tab.
      verify();
      const saved = registration.commit();
      setProjectId(saved.id); setProjects(readSavedProjectsStrict()); setGitRegistration(null);
      setGitNotice("完整本机版本已登记到作品列表。");
    } catch (cause) { setGitNotice(cause instanceof Error ? cause.message : "作品列表登记未确认，请先导出备份。"); }
  };
  const openLocalGitVersion = async () => {
    if (!gitRegistration || busy || submitting || composing) return;
    try {
      assertLocalWorkspaceCurrent(workspaceBaseline.current);
      const input = registrationInput.current;
      const guarded = [...new Set([gitRegistration.id, project?.id].filter((id): id is string => typeof id === "string"))];
      assertAuthoringCanLeave(guarded);
      const local = await loadLocalGitVersion(gitRegistration.id);
      if (!mounted.current || registrationInput.current !== input) throw new Error("载入期间编辑区已变化，未替换当前输入。");
      const listRaw = localStorage.getItem("glint.projects");
      const matches = readSavedProjectsStrict().filter(item => item.id === local.project.id || item.project?.id === local.project.id);
      if (matches.length > 1) throw new Error("多个作品匹配同一工程，请先核对列表，未替换当前输入。");
      const discovered = discoveredGit.current?.project.id === local.project.id ? discoveredGit.current : null;
      discovered?.assertCurrent();
      const source = matches[0] ?? (project?.id === local.project.id ? { mode, text, template, theme, evidence } : discovered?.context);
      if (!source && !discovered) throw new Error("当前工程不匹配且作品入口未记录原资料；请先从本机工程列表核对，未将其他作品资料混入本机版本。");
      if (!window.confirm(`${!source ? "未找到匹配的原资料记录，将使用空资料与空凭据，不套用当前工程文字。" : ""}载入此工程上次接受的本机主快照及当前本机附件？这不是某次 Git 提交的还原；附件可能包含后续编辑。当前未保存输入会被替换，请先导出当前工程 JSON（不含脚本、设计或素材文件）。`)) return;
      if (registrationInput.current !== input || localStorage.getItem("glint.projects") !== listRaw) throw new Error("确认期间编辑区或作品列表已变化，未替换当前输入。");
      assertAuthoringCanLeave(guarded);
      assertLocalWorkspaceCurrent(workspaceBaseline.current); local.assertCurrent();
      discovered?.assertCurrent();
      const context = { mode: source?.mode ?? "source" as const, text: source?.text ?? "", template: source?.template ?? "explainer", theme: themeForSelector(local.project.theme) ?? source?.theme ?? "glint-dark", evidence: source?.evidence ?? "" };
      workspaceBaseline.current = saveLocalWorkspace({ ...context, aspect: local.project.aspect, project: local.project }, workspaceBaseline.current);
      setMode(context.mode); setText(context.text); setTemplate(context.template); setEvidence(context.evidence);
      setProject(local.project); syncProjectTheme(local.project); setAspect(local.project.aspect); setEditorVersion(value => value + 1);
      setProjectId(null); setReview(null); setError(""); setGitRegistration(local.project); navigate("workspace");
      setGitNotice("已载入上次接受的本机主快照和当前本机附件（可能含后续编辑），未还原 Git 提交；可继续核对并登记作品。");
    } catch (cause) { setGitNotice(cause instanceof Error ? cause.message : "本机版本未载入，当前输入仍保留。"); }
  };
  useEffect(() => { setRevisions(projectId ? readRevisions(projectId) : []); }, [projectId]);
  const refreshRevisions = (id: string | null = projectId) => setRevisions(id ? readRevisions(id) : []);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorProject = useMemo(() => project ? { ...project, aspect: aspect as SceneScriptProject["aspect"] } : null, [project, aspect]);
  const themeWarning = project ? unsupportedTheme(project.theme) : undefined;
  const selectorTheme = project?.theme !== undefined ? themeForSelector(project.theme) ?? "" : theme;
  const syncProjectTheme = (next: SceneScriptProject, fallback = "glint-dark") => setTheme(themeForSelector(next.theme) ?? ((THEME_IDS as readonly string[]).includes(fallback) ? fallback : "glint-dark"));
  const useRecipe = (recipe: { title: string; sample: string; sampleMode: "source" | "idea"; template: string; theme: string; aspect: string }) => {
    setRecipePreset({ label: recipe.title, text: recipe.sample, aspect: recipe.aspect === "9:16" || recipe.aspect === "1:1" ? recipe.aspect : "16:9", template: recipe.template, theme: recipe.theme, nonce: Date.now() });
    setStorageStatus(`已套用模板：${recipe.title}`);
    navigate("home");
  };
  const receiveSessionProject = (next: SceneScriptProject) => {
    // The session client echoes the editor project back after every connect/save
    // (including failed connects); only a genuinely different project may drop
    // the pending narration review.
    if (editorProject && JSON.stringify(editorProject) === JSON.stringify(next)) return;
    setProject(next); syncProjectTheme(next); setAspect(next.aspect); setReview(null);
  };
  const importRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const submission = useRef<{ signature: string; requestId: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = !restored || Boolean(recoveryRequest || job && !terminalJob(job));
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => { try {
      setProjects(readSavedProjects());
      const workspace = await recoverStudioWorkspace();
      if (cancelled) return;
      if (JSON.stringify(readWorkspace(localStorage)) !== JSON.stringify(workspace)) throw new Error("恢复期间其他窗口更新了工作区，未载入过期草稿；请重新载入核对。");
      workspaceBaseline.current = localStorage.getItem("glint.workspace");
      if (workspace && typeof workspace.text === "string" && workspace.text.length <= 12000) {
        setText(workspace.text); setMode(workspace.mode === "idea" ? "idea" : "source");
        if (typeof workspace.template === "string" && TEMPLATES.some(item => item.id === workspace.template)) setTemplate(workspace.template);
        if (typeof workspace.theme === "string" && (THEME_IDS as readonly string[]).includes(workspace.theme)) setTheme(workspace.theme);
        if (typeof workspace.aspect === "string" && ["16:9", "9:16", "1:1"].includes(workspace.aspect)) setAspect(workspace.aspect);
        if (workspace.project) {
          const restoredProject = parseEditorProject(workspace.project); setProject(restoredProject);
          syncProjectTheme(restoredProject, typeof workspace.theme === "string" ? workspace.theme : undefined);
          // A workspace may contain a newer, not-yet-applied aspect selection.
          // Git restores persist the accepted project's aspect in the same transaction.
          if (typeof workspace.aspect !== "string" || !["16:9", "9:16", "1:1"].includes(workspace.aspect)) setAspect(restoredProject.aspect);
          try {
            const complete = readGitProject(restoredProject.id);
            if (complete && sameGitProject(complete, restoredProject)) registerGitProject(restoredProject, {
              mode: workspace.mode === "idea" ? "idea" : "source", text: workspace.text,
              template: typeof workspace.template === "string" ? workspace.template : "explainer",
              theme: themeForSelector(restoredProject.theme) ?? (typeof workspace.theme === "string" ? workspace.theme : "glint-dark"),
              ...(typeof workspace.evidence === "string" ? { evidence: workspace.evidence } : {}),
            }, false);
          } catch (cause) { setGitRegistration(restoredProject); setGitNotice(cause instanceof Error ? cause.message : "完整本机版本待核对。"); }
        }
        if (typeof workspace.evidence === "string") setEvidence(workspace.evidence);
        setStorageStatus("已恢复本机草稿");
      }
      const saved = localStorage.getItem(key);
      const pending = localStorage.getItem(`${key}:request`);
      if(pending && /^[a-zA-Z0-9-]{8,80}$/.test(pending)) setRecoveryRequest(pending);
      else if (saved && /^idea-[a-z0-9-]+$/.test(saved)) setJob({ id: saved, status: "recovering", stage: "recovering", log: [] });
    } catch (cause) {
      if (cancelled) return;
      setStorageWarning(true); setStorageRecoveryBlocked(true);
      setStorageStatus(cause instanceof Error ? cause.message : "本机恢复未完成，未覆盖原始工作区；请先导出备份。");
    }
    if (!cancelled) setRestored(true);
    })();
    return () => { cancelled = true; mounted.current = false; active.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!restored || storageRecoveryBlocked) return;
    const timer = setTimeout(() => {
      try {
        workspaceBaseline.current = saveLocalWorkspace({ mode, text, template, theme, aspect, project, evidence }, workspaceBaseline.current);
        setStorageStatus("已自动保存到本机"); }
      catch (cause) { setStorageWarning(true); setStorageStatus(cause instanceof Error ? cause.message : "本机存储不可用，请导出 JSON 备份"); }
    }, 600);
    return () => clearTimeout(timer);
  }, [restored, storageRecoveryBlocked, mode, text, template, theme, aspect, project, evidence]);
  const rememberProject = () => {
    if (!text.trim() && !project) return;
    try {
      const next = saveProject({ id: projectId ?? crypto.randomUUID(), name: project?.title ?? text.trim().split(/\r?\n/)[0]?.slice(0, 42) ?? "未命名项目", mode, text, template, theme, aspect, ...(project ? { project, evidence } : {}) });
      recordRevision(next, { label: "手动保存", reason: "manual" }); refreshRevisions(next.id);
      setProjectId(next.id); setProjects(readSavedProjects()); setStorageStatus("项目已保存");
    } catch { setError("保存失败，请导出项目 JSON 备份。"); }
  };
  const restoreProject = (saved: SavedProject) => {
    if (busy || submitting || composing) return;
    try {
      if (storageRecoveryBlocked) throw new Error("本机恢复尚未完成；请先重试本机恢复，未打开旧作品快照。");
      const targetId = saved.project?.id ?? saved.id;
      const guarded = [targetId, ...(project ? [project.id] : [])];
      assertAuthoringCanLeave(guarded);
      assertGitStorageReady(targetId);
      assertLocalWorkspaceCurrent(workspaceBaseline.current);
      const current = readSavedProjectsStrict().find(item => item.id === saved.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(saved)) throw new Error("作品列表已变化；未打开过期快照，请刷新后核对。");
      const next = saved.project ? parseEditorProject(saved.project) : null;
      const complete = readGitProject(targetId);
      if (complete && (!next || !sameGitProject(complete, next))) {
        setGitRegistration(complete);
        setGitNotice("该作品的列表分镜与上次 Git 完整版本不同。脚本、设计、品牌和素材不会随列表快照恢复；也可显式载入本机主快照与当前附件。");
        const input = registrationInput.current;
        if (!window.confirm(next ? "仅载入作品列表的分镜快照？脚本、设计、品牌及素材仍保留当前本机内容，不会执行 Git 完整恢复。取消可保留当前编辑区。"
          : "该文本作品同编号下保留了完整本机主快照。仅载入列表文本草稿（不含分镜）？不会恢复脚本、设计、品牌或素材；取消可保留当前编辑区。")) return;
        // Confirmation is not a lock: recheck disk, rendered input and list before accepting the choice.
        assertGitStorageReady(targetId); assertLocalWorkspaceCurrent(workspaceBaseline.current);
        const latest = readGitProject(targetId);
        if (registrationInput.current !== input || JSON.stringify(readSavedProjectsStrict().find(item => item.id === saved.id)) !== JSON.stringify(saved) || !latest || !sameGitProject(latest, complete))
          throw new Error("确认期间本机版本变化，未载入过期快照。");
      }
      assertAuthoringCanLeave(guarded);
      setMode(saved.mode); setText(saved.text); setTemplate(saved.template); if (next) syncProjectTheme(next, saved.theme); else setTheme(saved.theme); setAspect(next?.aspect ?? saved.aspect);
      setProject(next); setEditorVersion(value => value + 1); setEvidence(saved.evidence ?? ""); setReview(null); setProjectId(saved.id); setError("");
      if (next) navigate("workspace"); else openTool("create");
    } catch (cause) { setGitNotice(cause instanceof Error ? cause.message : "打开作品未确认，当前输入仍保留。"); }
  };
  const openProjectById = (id: string): boolean => {
    if (project?.id === id) { navigate("workspace"); return true; }
    const saved = readSavedProjects().find(item => (item.project?.id ?? item.id) === id || item.id === id);
    if (!saved) { setGitNotice("没有找到这个工程：它可能已被删除，或保存在另一台设备上。"); return false; }
    restoreProject(saved);
    return true;
  };
  useStudioRoute({ ready: restored, request: location, view, projectId: project?.id, navigate, openProject: openProjectById, onLocationChange });
  const retryLocalRecovery = async () => {
    try {
      const recovered = await recoverStudioWorkspace();
      if (!mounted.current) return;
      const recoveredProject = recovered?.project ? parseEditorProject(recovered.project) : null;
      assertGitStorageReady(recoveredProject?.id);
      if (storageRecoveryBlocked || localStorage.getItem("glint.workspace") !== workspaceBaseline.current) {
        setGitNotice("本机恢复核对完成。为保留当前内存输入，请先导出当前草稿，再重新载入页面；未用磁盘版本覆盖编辑区。");
        return;
      }
      setGitNotice("恢复日志已清理；当前输入仍保留，可重试登记作品。");
    } catch (cause) { setGitNotice(cause instanceof Error ? cause.message : "本机恢复尚未完成，原始资料仍保留。"); }
  };
  const compose = async () => {
    if (lock.current || busy || !text.trim()) return;
    if (themeWarning) { setError(themeWarning); return; }
    if (project?.theme && typeof project.theme === "object" && !window.confirm("重新生成会替换当前分镜及工程中保存的风格参数或快照。是否继续？")) return;
    lock.current = true; setComposing(true); setError("");
    const controller = new AbortController(); active.current = controller;
    try {
      const response = await fetch("/api/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [mode]: text, engine, template, theme, aspect }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "编排失败");
      if (mounted.current) { const next = parseEditorProject(value.project); setProject(next); syncProjectTheme(next, theme); setEditorVersion(value => value + 1); setEvidence(value.source); setReview(value.review); navigate("workspace"); if (value.generatedSource) setStorageStatus("模型生成的资料尚未经外部事实核验"); }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "编排失败"); }
    finally { lock.current = false; if (mounted.current) setComposing(false); }
  };
  const recheck = async () => {
    if (!project || !evidence) return;
    try { const input = currentReviewInput.current; const result = await jobRequest("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: evidence, project }) }); if (mounted.current && currentReviewInput.current.project === input.project && currentReviewInput.current.evidence === input.evidence) setReview(result); }
    catch { setError("核对失败，请检查资料与项目格式。"); }
  };
  useEffect(()=>{
    if(!recoveryRequest || paused)return;
    const controller=new AbortController();
    void jobRequest(`/api/make/request/${recoveryRequest}`,{},controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      const next=parseJob(value);setJob(next);setRecoveryRequest(null);setError("");
      try{localStorage.setItem(key,next.id);localStorage.removeItem(`${key}:request`);}catch{}
    }).catch(()=>{if(!controller.signal.aborted){setPaused(true);setError("提交回执未确认。可恢复查询；不会自动重新提交任务。");}});
    return()=>controller.abort();
  },[recoveryRequest,retry,paused]);
  useEffect(() => {
    if (!job || terminalJob(job) || paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = parseJob(await jobRequest(`/api/make/${job.id}`, {}, controller.signal));
        if (controller.signal.aborted) return;
        failures = 0; setJob(next); setError("");
        if (terminalJob(next)) { submission.current = null; return; }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (++failures >= 3) { setPaused(true); setError("连接中断，任务可能仍在运行。点击恢复查询。"); return; }
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, busy, paused, retry]);
  const submit = async () => {
    if (lock.current || busy || (!text.trim() && !project)) return;
    if (themeWarning) { setError(themeWarning); return; }
    if (costBlocked) { setError("当前配音引擎可能产生费用，请先勾选“我确认可能产生费用”。"); return; }
    lock.current = true; setSubmitting(true); setError("");
    const controller = new AbortController(); active.current = controller;
    const payload = { ...(editorProject ? { project: editorProject } : { [mode]: text }), template, theme, aspect, tts, encoding, music };
    const signature = JSON.stringify(payload);
    if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
    try { localStorage.setItem(`${key}:request`,submission.current.requestId); } catch {}
    try {
      const result = await jobRequest("/api/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, requestId: submission.current.requestId }) }, controller.signal);
      const next = { ...parseJob({ id: result.jobId, status: "queued", log: [] }), status: "recovering" as const, stage: "recovering" };
      if (!mounted.current) return;
      setJob(next); setPaused(false);
      try { localStorage.setItem(key, next.id); localStorage.removeItem(`${key}:request`); } catch { /* Optional persistence. */ }
    } catch (err) { if (mounted.current) {
      setError(err instanceof Error ? err.message : "提交失败，可恢复查询。");
      if([400,413,503].includes((err as {status?:number})?.status ?? 0)){try{localStorage.removeItem(`${key}:request`);}catch{}}
      else{setRecoveryRequest(submission.current.requestId);setPaused(true);}
    } }
    finally { lock.current = false; if (mounted.current) setSubmitting(false); }
  };
  const cancel = async () => {
    if (!job) return;
    const controller = new AbortController(); active.current = controller;
    setJob({ ...job, status: "cancelling", stage: "stopping" });
    try { await jobRequest(`/api/make/${job.id}`, { method: "DELETE" }, controller.signal); setPaused(false); setRetry((value) => value + 1); }
    catch { if (mounted.current) setError("取消请求未确认，请恢复查询后重试。"); }
  };
  const loadProjectDocument = (value: unknown) => {
    try {
      const next = parseEditorProject(value);
      assertAuthoringCanLeave([next.id, ...(project ? [project.id] : [])]);
      if (project) {
        try { saveProject({ id: projectId ?? crypto.randomUUID(), name: project.title, mode, text, template, theme, aspect, project, evidence }); setProjects(readSavedProjects()); }
        catch { throw new Error("当前工程备份失败，请先导出项目 JSON，再继续编辑。"); }
      }
      setProject(next); setEditorVersion(version => version + 1); setAspect(next.aspect);
      syncProjectTheme(next);
      setProjectId(null); setReview(null); setEvidence(""); setError("");
      setStorageStatus("已载入新工程，可继续修改"); navigate("workspace");
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "无法载入工程，请重试。"); return false; }
  };
  const applySnapshot = (snapshot: SavedProject) => {
    const next = snapshot.project ? parseEditorProject(snapshot.project) : null;
    assertAuthoringCanLeave([snapshot.project?.id ?? snapshot.id, ...(project ? [project.id] : [])]);
    setMode(snapshot.mode); setText(snapshot.text); setTemplate(snapshot.template); if (next) syncProjectTheme(next, snapshot.theme); else setTheme(snapshot.theme); setAspect(snapshot.aspect);
    setProject(next);
    setEvidence(snapshot.evidence ?? ""); setReview(null); setError(""); setEditorVersion(version => version + 1);
  };
  const beforeHomeCreate = () => {
    const input = registrationInput.current, signature = JSON.stringify(input);
    const verify = () => {
      if (JSON.stringify(registrationInput.current) !== signature) throw new Error("生成期间当前工程已变化；新工程结果保留，请先保存当前修改再打开。");
      assertLocalWorkspaceCurrent(workspaceBaseline.current);
      assertAuthoringCanLeave(input.project ? [input.project.id] : []);
      if (readSavedProjectsStrict().length >= 20) throw new Error("作品列表已满，请先整理或导出作品，再开始新工程。");
    };
    verify(); return verify;
  };
  const acceptHomeProject = (work: ComposedWork, context: ComposeContext) => {
    const next = parseEditorProject(work.project), input = registrationInput.current;
    assertLocalWorkspaceCurrent(workspaceBaseline.current);
    assertAuthoringCanLeave([next.id, ...(input.project ? [input.project.id] : [])]);
    const list = readSavedProjectsStrict(), targets = list.filter(item => item.id === next.id || item.project?.id === next.id);
    if (targets.length > 1 || targets[0] && (!targets[0].project || !sameGitProject(targets[0].project, next))) throw new Error("新工程编号已被其他作品使用；结果保留，未覆盖旧作品。");
    const old = input.project && input.project.id !== next.id ? list.filter(item => item.project?.id === input.project!.id) : [];
    if (old.length > 1) throw new Error("当前工程有多个作品入口，请先核对后再打开新工程。");
    const oldId = projectId ?? old[0]?.id ?? input.project?.id;
    const targetId = targets[0]?.id ?? next.id;
    if (new Set([...list.map(item => item.id), targetId, ...(input.project && oldId ? [oldId] : [])]).size > 20) throw new Error("作品列表已满；新工程结果保留，请先整理作品，不会淘汰旧作品。");
    if (input.project && input.project.id !== next.id && oldId) saveProject({ id: oldId, name: input.project.title, mode: input.mode, text: input.text, template: input.template, theme: input.theme, aspect: input.aspect, project: input.project, evidence: input.evidence });
    const nextTheme = themeForSelector(next.theme) ?? context.theme;
    const nextTemplate = TEMPLATES.some(item => item.id === context.template) ? context.template : "explainer";
    const saved = saveProject({ id: targetId, name: next.title, mode: "source", text: work.source, template: nextTemplate, theme: nextTheme, aspect: next.aspect, project: next, evidence: work.source });
    setMode("source"); setText(work.source); setTemplate(nextTemplate); setTheme(nextTheme); setAspect(next.aspect);
    setProject(next); setProjectId(saved.id); setEditorVersion(value => value + 1); setEvidence(work.source); setReview(null); setError(""); setProjects(readSavedProjectsStrict());
    try { recordRevision(saved, { label: "首次生成", reason: "generated" }); refreshRevisions(saved.id); }
    catch { setStorageStatus("工程已保存，历史记录写入未确认；请导出备份。"); }
    navigate("workspace");
  };
  const restoreFromRevision = (revision: ProjectRevision) => {
    try {
      const snapshot = restoreRevision(revision);
      applySnapshot(snapshot); setProjectId(snapshot.id); navigate("workspace");
      setStorageStatus(`已载入版本「${revision.label}」；保存后覆盖当前工程`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "历史版本未载入，当前输入仍保留。"); }
  };
  const branchFromRevision = (revision: ProjectRevision) => {
    try {
      assertAuthoringCanLeave([revision.snapshot.project?.id ?? revision.snapshot.id, ...(project ? [project.id] : [])]);
      const branch = saveProject(branchRevision(revision));
      applySnapshot(branch); setProjectId(branch.id); setProjects(readSavedProjects());
      recordRevision(branch, { label: `分支自 ${revision.label}`, reason: "branch" }); refreshRevisions(branch.id);
      navigate("workspace"); setStorageStatus(`已创建分支「${branch.name}」`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建分支失败：本机存储不可用"); }
  };
  const workspaceProps = {
    editorVersion, view, onOpenTimeline, storageRecoveryBlocked, receiveSessionProject, registerGitProject,
    tool, openTool, setTool, error, revisions, restoreFromRevision,
    branchFromRevision, busy, composing, submitting, text, project,
    rememberProject, setMode, setText, setProject, setReview, importRef,
    loadProjectDocument, setError, storageStatus, setBackupSelection, refreshSessionBackups, backupNotice,
    sessionBackups, setBackupNotice, backupRecovering, backupSelection, recoveryLock, setBackupRecovering,
    mounted, setProjects, loadSharedProjects, sharedMessage, sharedProjects, projectId,
    openSharedProject, projects, restoreProject, refreshRevisions, visited, mode,
    setEvidence, aspect, template, setTemplate, selectorTheme, setTheme,
    setAspect, themeWarning, engine, setEngine, compose, editorProject,
    lock, syncProjectTheme, setEditorVersion, setProjectId, setStorageStatus, navigate,
    evidence, recheck, review, tts, setTts, voiceEngines,
    music, refreshMusic, setMusic, musicAssets, encoding, setEncoding,
    costConfirmed, setCostConfirmedKey, preflightKey, costBlocked, submit, job,
    cancel, recoveryRequest, setRecoveryRequest, setPaused, paused, setRetry,
    setJob, submission, theme,
  };
  return <section aria-label="创作首页" className="idea-studio" data-view={view} onKeyDown={event => {
    if (event.key === "Escape") setTool(null);
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy && !submitting && !composing) rememberProject(); }
  }}>
    {gitNotice && <section aria-label="完整本机版本与作品列表" className="studio-note"><p role="status">{gitNotice}</p><div className="ws-actions">
      {gitRegistration && <><button type="button" className="g-btn g-btn--sm" onClick={retryGitRegistration}>登记完整本机版本</button><button type="button" className="g-btn g-btn--sm" disabled={busy || submitting || composing} onClick={openLocalGitVersion}>载入本机主快照与当前附件</button></>}
      <button type="button" className="g-btn g-btn--sm" onClick={retryLocalRecovery}>重试本机恢复</button>
      {project && <button type="button" className="g-btn g-btn--sm" title="仅含分镜工程，不含脚本、设计或素材文件" onClick={() => downloadJson(`${project.id}.local-draft.json`, project)}>导出当前工程 JSON</button>}
    </div></section>}
    <div hidden={view !== "home"}>
      <HomeHero projects={projects} onOpen={restoreProject} disabled={busy || submitting || composing} preset={recipePreset}
        onOpenPlan={() => navigate("plan")} onOpenTemplates={() => navigate("templates")}
        onOpenReference={() => openTool("reference")} onOpenProject={() => openTool("imports")} onOpenAdvanced={() => openTool("create")}
        onContinue={project || busy || paused || job ? () => { if (busy || paused || job) openTool("export"); else navigate("workspace"); } : undefined}
        continueLabel={busy || paused ? "继续进行中的任务" : project?.title} currentProjectId={project?.id}
        onEditProject={loadProjectDocument} beforeCreate={beforeHomeCreate} onCreateProject={acceptHomeProject} onOpenSettings={onOpenSettings} />
      <details className="ws-details home-recovery" onToggle={event => { if (event.currentTarget.open) setGitWorksOpen(true); }}>
        <summary>查找待登记的本机 Git 工程</summary>
        {gitWorksOpen && <Suspense fallback={<p role="status">正在读取本机工程…</p>}><LocalGitWorks disabled={busy || submitting || composing} onSelect={selected => {
          discoveredGit.current = selected; setGitRegistration(selected.project);
          setGitNotice(`已选中「${selected.project.title}」的本机主快照；当前输入未变。请载入核对后登记作品。${selected.warning}`);
        }} /></Suspense>}
        {gitSourceNotice && <p role="status" className="ws-note">{gitSourceNotice}</p>}
      </details>
    </div>
    {(visited.plan || visited.templates) && <Suspense fallback={<p role="status">正在打开工程…</p>}><IdeaStudioViews {...workspaceProps} setComposing={setComposing} active={active} useRecipe={useRecipe} /></Suspense>}
    {(workspaceToolsVisited || editorProject || view === "workspace") && <Suspense fallback={<p role="status">正在打开工程…</p>}><IdeaStudioWorkspace {...workspaceProps} /></Suspense>}
    {storageWarning && <p role="alert" className="studio-error">{storageStatus}</p>}
    {error && !tool && <p role="alert" className="studio-error">{error}</p>}
    {job && <div className="studio-task-status" role="status" aria-live="polite"><span>{labels[job.stage ?? job.status] ?? job.status}{job.status === "failed" ? `：${job.error ?? "请检查资料结构和模型配置。"}` : ""}</span><button className="g-btn g-btn--sm" onClick={() => openTool("export")}>查看任务</button></div>}
  </section>;
}
