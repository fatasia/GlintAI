import { applicationUrl } from "./app-url";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { QuickVideoPreset } from "./QuickVideo";
import type { ComposedWork, ComposeContext } from "./ProjectComposer";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./creation-start.css";
const GeneratedVideoStart = lazy(() => import("./GeneratedVideoStart").then(module => ({ default: module.GeneratedVideoStart })));
const ProjectComposer = lazy(() => import("./ProjectComposer").then(module => ({ default: module.ProjectComposer })));
const QuickGif = lazy(() => import("./QuickGif").then(module => ({ default: module.QuickGif })));
import type { SavedProject } from "./project-history";
import "./home-workspace.css";
import "./creation-flow.css";
const QuickImage = lazy(() => import("./QuickImage").then(module => ({ default: module.QuickImage })));
const MODES = [["video", "视频创作"], ["image", "图片生成"], ["gif", "GIF 导出"]] as const;
const STARTERS: Array<Omit<QuickVideoPreset, "nonce"> & { image: string }> = [
  { label: "产品发布", image: "/showcase/coffee-still.webp", text: "为我的产品制作一条竖屏发布视频，先展示使用场景，再介绍卖点，最后引导体验。", aspect: "9:16", theme: "bold-poster", template: "explainer" },
  { label: "知识讲解", image: "/showcase/entropy-second-law.png", text: "用一杯热咖啡和一块冰，解释熵增原理，让零基础观众也能理解。", aspect: "16:9", theme: "blackboard-tech", template: "explainer" },
  { label: "操作教程", image: "/showcase/uncertainty-intro.png", text: "制作一条整理工作桌面的教程，分为清空、分类、归位三个步骤。", aspect: "16:9", theme: "mint-clean", template: "howto" },
  { label: "观点速览", image: "/showcase/entropy-intro.png", text: "把减少会议时间的三个建议做成速览：会前明确议题、会上控制时间、会后记录行动。", aspect: "1:1", theme: "cream-editorial", template: "listicle" },
];
export function HomeHero({ projects, onOpen, disabled = false, onEditProject, preset, onOpenReference, onOpenPlan, onOpenTemplates, onOpenProject, onOpenAdvanced, onContinue, continueLabel, currentProjectId, beforeCreate, onCreateProject, onOpenSettings }: {
  projects: SavedProject[]; onOpen(project: SavedProject): void; disabled?: boolean;
  onEditProject?(project: unknown): void; preset?: QuickVideoPreset; onOpenReference?: () => void;
  onOpenPlan?: () => void; onOpenTemplates?: () => void; onOpenProject?: () => void;
  onOpenAdvanced?: () => void;
  onContinue?: () => void; continueLabel?: string;
  /** Id of the project open in the editor; its card is marked so it is not mistaken for a second work. */
  currentProjectId?: string;
  beforeCreate?(): () => void; onCreateProject?(work: ComposedWork, context: ComposeContext): void | boolean; onOpenSettings?(): void;
}) {
  const [kind, setKind] = useState<"video" | "image" | "gif">("video");
  const [path, setPath] = useState<"motion" | "generated">();
  const [generatedVisited, setGeneratedVisited] = useState(false), [mediaBusy, setMediaBusy] = useState(false);
  const [visited, setVisited] = useState({ image: false, gif: false });
  const [selected, setSelected] = useState<QuickVideoPreset | undefined>(preset);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);
  const composer = useRef<HTMLDivElement>(null);
  const nonce = useRef(Date.now());
  useEffect(() => { if (preset) { setKind("video"); setPath("motion"); setSelected(preset); } }, [preset]);
  const locked = disabled || videoBusy || mediaBusy;
  const start = (starter: typeof STARTERS[number]) => {
    if (locked) return;
    const existing = composer.current?.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')?.value;
    if (existing?.trim() && !window.confirm("替换当前创作描述？尚未生成的文字会被替换。")) return;
    setKind("video"); setPath("motion"); setSelected({ ...starter, nonce: ++nonce.current });
    setNotice(`已载入「${starter.label}」：${starter.aspect}。请补充你的内容后生成。`);
    requestAnimationFrame(() => {
      composer.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      composer.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    });
  };
  const visible = projects.filter(project => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="home-workspace" aria-label="创作工作台">
    <header className="home-heading">
      <h1>把想法变成作品</h1>
      <p className="home-lede">描述需求，或添加资料。先生成可编辑的工程，再决定怎么交付。</p>
    </header>
    <div className="home-create-layout">
      <div className="home-compose" ref={composer}>
        <div className="home-modes" role="group" aria-label="创作类型">{MODES.map(([value, label]) => <button key={value} type="button" disabled={locked} aria-pressed={kind === value} onClick={() => { setKind(value); if (value !== "video") setVisited(current => ({ ...current, [value]: true })); }}>{label}</button>)}</div>
        <div hidden={kind !== "video"}>
          <div className="creation-paths" role="group" aria-label={t("creation.paths")}>
            {(["generated", "motion"] as const).map(value => <Button key={value} disabled={locked} aria-pressed={path === value} onClick={() => { setPath(value); if (value === "generated") setGeneratedVisited(true); }}><strong>{t(value === "generated" ? "creation.generated" : "creation.motion")}</strong><small>{t(value === "generated" ? "creation.generatedShort" : "creation.motionShort")}</small></Button>)}
          </div>
          <div hidden={path !== "motion"}><Suspense fallback={<p role="status" className="home-note">正在准备创作…</p>}><ProjectComposer disabled={disabled || mediaBusy} onBusyChange={setVideoBusy} preset={selected} beforeCreate={beforeCreate} onCreated={onCreateProject ?? (work => onEditProject?.(work.project))} onOpenSettings={onOpenSettings} /></Suspense></div>
          <div hidden={path !== "generated"}>{generatedVisited && <Suspense fallback={<p role="status">{t("workspace.loading")}</p>}><GeneratedVideoStart disabled={disabled || videoBusy} beforeCreate={beforeCreate} onCreated={onCreateProject ?? (work => onEditProject?.(work.project))} onOpenSettings={onOpenSettings} onBusyChange={setMediaBusy} /></Suspense>}</div>
        </div>
        <div hidden={kind !== "image"}>{visited.image && <Suspense fallback={<p role="status" className="home-note">正在加载图片工具…</p>}><QuickImage disabled={disabled} /></Suspense>}</div>
        <div hidden={kind !== "gif"}>{visited.gif && <Suspense fallback={<p role="status" className="home-note">正在加载 GIF 工具…</p>}><QuickGif projects={projects} disabled={disabled} /></Suspense>}</div>
        {notice && <p className="home-note" role="status">{notice}</p>}
      </div>
      <div className="home-inspiration" aria-label="创作起点">{STARTERS.map(starter => <button type="button" className="home-starter" key={starter.label} disabled={locked} onClick={() => start(starter)} aria-label={`使用${starter.label}起点`}>
        <span className="home-starter-cover"><img src={applicationUrl(starter.image)} alt="" loading="lazy" /></span><span>{starter.label}</span>
      </button>)}</div>
      <nav className="home-shortcuts" aria-label="其他创作入口">
        {onOpenTemplates && <button type="button" className="home-link" disabled={locked} onClick={onOpenTemplates}>浏览模板</button>}
        {onOpenProject && <button type="button" className="home-link" disabled={locked} onClick={onOpenProject}>打开工程</button>}
        <details className="home-more"><summary>更多方式</summary><div>
          {onOpenPlan && <button type="button" className="home-link" disabled={locked} onClick={onOpenPlan}>先看方案</button>}
          {onOpenReference && <button type="button" className="home-link" disabled={locked} onClick={onOpenReference}>从参考片开始</button>}
          {onOpenAdvanced && <button type="button" className="home-link" disabled={locked} onClick={onOpenAdvanced}>更多创作选项</button>}
        </div></details>
      </nav>
    </div>
    <section aria-label="最近作品" className="home-recent">
      <div className="home-section-heading">
        <h2>最近作品</h2>
        <span className="home-section-rule" aria-hidden="true" />
        <input type="search" aria-label="搜索最近作品" placeholder="搜索作品" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      {onContinue && <button type="button" className="home-resume" onClick={onContinue}>
        <span className="home-resume-dot" aria-hidden="true" />
        <span className="home-resume-copy"><strong>{continueLabel || "继续上次创作"}</strong><small>返回当前编辑区</small></span>
        <span className="home-resume-arrow" aria-hidden="true">继续 →</span>
      </button>}
      {visible.length ? <div className="home-projects">{visible.slice(0, 8).map(project => {
        const current = Boolean(currentProjectId) && (project.project?.id ?? project.id) === currentProjectId;
        return <button className="home-project" key={project.id} data-current={current || undefined} disabled={locked} onClick={() => onOpen(project)}>
          <span className="home-project-cover" aria-hidden="true"><span>{project.project ? "视频工程" : "创作资料"}{current ? " · 正在编辑" : ""}</span><strong>{project.name}</strong></span>
          <span className="home-project-copy"><strong title={project.name}>{project.name}</strong><small><span>{project.aspect}</span><span>{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</span><span>{project.project ? "可编辑工程" : "创作草稿"}</span></small></span>
          <span className="home-project-arrow" aria-hidden="true">→</span>
        </button>;
      })}</div> : <div className="home-empty"><div><strong>{query ? "没有匹配的作品" : "作品会保存在这里"}</strong><span>{query ? "换一个关键词，或清空搜索。" : "从上面的输入开始，保存后随时回来继续。"}</span></div>{query && <button type="button" className="home-link" onClick={() => setQuery("")}>清空搜索</button>}</div>}
    </section>
  </section>;
}
