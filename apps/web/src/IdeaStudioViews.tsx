import { lazy, Suspense, type Dispatch, type RefObject, type SetStateAction } from "react";
import { appFetch as fetch } from "./app-url";
import { parseEditorProject } from "./editor-model";
import { saveProject, readSavedProjects } from "./project-history";
import { recordRevision } from "./project-revisions";
import type { WorkspaceProps } from "./IdeaStudioWorkspace";
const CreationWizard = lazy(() => import("./CreationWizard").then(module => ({ default: module.CreationWizard })));
const RecipeGallery = lazy(() => import("./RecipeGallery").then(module => ({ default: module.RecipeGallery })));
const CreationLibrary = lazy(() => import("./CreationLibrary").then(module => ({ default: module.CreationLibrary })));
type Props = Pick<WorkspaceProps, "view" | "navigate" | "project" | "visited" | "busy" | "submitting" | "composing" | "lock" | "setError" | "mounted" | "projectId" | "mode" | "text" | "template" | "theme" | "aspect" | "evidence" | "syncProjectTheme" | "setAspect" | "setMode" | "setText" | "setProject" | "setEditorVersion" | "setReview" | "setEvidence" | "setProjectId" | "setProjects" | "refreshRevisions" | "setStorageStatus"> & {
  setComposing: Dispatch<SetStateAction<boolean>>;
  active: RefObject<AbortController | null>;
  useRecipe(recipe: { title: string; sample: string; sampleMode: "source" | "idea"; template: string; theme: string; aspect: string }): void;
};
export default function IdeaStudioViews({ view, navigate, project, visited, busy, submitting, composing, lock, setError, mounted, projectId, mode, text, template, theme, aspect, evidence, syncProjectTheme, setAspect, setMode, setText, setProject, setEditorVersion, setReview, setEvidence, setProjectId, setProjects, refreshRevisions, setStorageStatus, setComposing, active, useRecipe }: Props) {
 return <>
    <section className="studio-view" aria-label="方案视图" hidden={view !== "plan"}>
      <header className="studio-view-heading"><button className="g-btn g-btn--quiet" onClick={() => navigate("home")}>返回作品</button><div><h1>先想清楚，再制作</h1><p>确认内容与分镜，方案会保留在这里。</p></div>{project && <button className="g-btn g-btn--quiet" onClick={() => navigate("workspace")}>继续编辑工程</button>}</header>
      {visited.plan && <Suspense fallback={<p role="status">正在加载向导…</p>}>
        <CreationWizard disabled={busy || submitting || composing} onCompose={async (source, options, plan, requestId) => {
          if (lock.current || busy || submitting) return;
          lock.current = true; setComposing(true); setError("");
          const controller = new AbortController(); active.current = controller;
          try {
          const response = await fetch("/api/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan, requestId }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error ?? "工程生成失败，分镜已保留。");
          const next = parseEditorProject(value.project);
          if (!mounted.current) return;
          if (project) {
            saveProject({ id: projectId ?? crypto.randomUUID(), name: project.title, mode, text, template, theme, aspect, project, evidence });
          }
          syncProjectTheme(next, typeof options.theme === "string" ? options.theme : "glint-dark");
          if (options.aspect === "9:16" || options.aspect === "1:1") setAspect(options.aspect); else setAspect("16:9");
          setMode("source"); setText(source);
          setProject(next); setEditorVersion(version => version + 1); setReview(value.review); setEvidence(source); setError("");
          const saved = saveProject({ id: next.id, name: next.title, mode: "source", text: source, template: "explainer", theme: options.theme, aspect: options.aspect, project: next, evidence: source });
          setProjectId(saved.id); setProjects(readSavedProjects());
          recordRevision(saved, { label: "生成分镜", reason: "generated" }); refreshRevisions(saved.id);
          navigate("workspace");
          setStorageStatus("分镜已制作成可编辑工程，并保存到最近作品");
          } finally { lock.current = false; if (mounted.current) setComposing(false); }
        }} />
      </Suspense>}
    </section>
    <section className="studio-view" aria-label="模板视图" hidden={view !== "templates"}>
      <header className="studio-view-heading"><button className="g-btn g-btn--quiet" onClick={() => navigate("home")}>返回作品</button><div><h1>从喜欢的样子开始</h1><p>选择描述或创作包，不会自动生成。</p></div></header>
      {visited.templates && <Suspense fallback={<p role="status">正在加载模板…</p>}><RecipeGallery onUse={useRecipe} /></Suspense>}
      {visited.templates && <section aria-label="创作包"><h2>可编辑创作包</h2>
      <Suspense fallback={<p role="status">正在加载创作包…</p>}><CreationLibrary disabled={busy || submitting || composing} onUse={instance => {
        if (project) {
          try { saveProject({ id: projectId ?? crypto.randomUUID(), name: project.title, mode, text, template, theme, aspect, project, evidence }); setProjects(readSavedProjects()); }
          catch { throw new Error("当前工程备份失败，请先导出 JSON，再切换创作包。"); }
        }
        const next = parseEditorProject(instance.project);
        setProject(next); syncProjectTheme(next); setAspect(next.aspect);
        setEditorVersion(value => value + 1); setProjectId(null); setReview(null); setEvidence(""); setError("");
        navigate("workspace"); setText(""); setStorageStatus(`已从创作包 ${instance.pack.id} v${instance.pack.version} 创建新工程`);
      }} /></Suspense>
      </section>}
    </section>
 </>;
}
