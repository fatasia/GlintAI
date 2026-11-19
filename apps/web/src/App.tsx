import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useHashLocation } from "wouter/use-hash-location";
import { appFetch as fetch } from "./app-url";
import { IdeaStudio } from "./IdeaStudio";
import { AuthoringVisibility } from "./authoring-visibility";
import { OfflineStatus } from "./OfflineStatus";
import { assertAllAuthoringCanLeave } from "./authoring-leave";
import { Rail, type Theme } from "./shell/Rail";
import type { PaletteCommand } from "./shell/command-filter";
import { readSavedProjects } from "./project-history";
import { AUTOMATION_TABS, LIBRARY_TABS, formatRoute, parseRoute, railArea, type AppRoute, type AutomationTab, type LibraryTab, type RailArea } from "./shell/routes";
import type { StudioLocation, StudioRequest } from "./shell/use-studio-route";
import { t, type MessageId } from "./ui/i18n";
import "./app-navigation.css";

// Keep tool dependencies out of the initial, immediately editable project view.
const ContainerWorkspace = lazy(() => import("./ContainerWorkspace"));
const ModelSettings = lazy(() => import("./ModelSettings").then(module => ({ default: module.ModelSettings })));
const BrandStudio = lazy(() => import("./BrandStudio").then(module => ({ default: module.BrandStudio })));
const GenCanvasBoard = lazy(() => import("./GenCanvasBoard").then(module => ({ default: module.GenCanvasBoard })));
const MediaWorkshop = lazy(() => import("./MediaWorkshop").then(module => ({ default: module.MediaWorkshop })));
const VoiceReview = lazy(() => import("./VoiceReview").then(module => ({ default: module.VoiceReview })));
const SkillCatalog = lazy(() => import("./SkillCatalog").then(module => ({ default: module.SkillCatalog })));
const NleEditor = lazy(() => import("./NleEditor").then(module => ({ default: module.NleEditor })));
const BatchWorkshop = lazy(() => import("./BatchWorkshop").then(module => ({ default: module.BatchWorkshop })));
const ExampleTools = lazy(() => import("./ExampleTools").then(module => ({ default: module.ExampleTools })));
const DocsPage = lazy(() => import("./DocsPage"));
const CommandPalette = lazy(() => import("./shell/CommandPalette"));
const TaskCenter = lazy(() =>
  import("./TaskCenter").then((module) => ({ default: module.TaskCenter })),
);

type ToolTab = LibraryTab | AutomationTab;
type ToolArea = "library" | "automation";
const TOOL_GROUPS: Record<ToolArea, { tabs: readonly ToolTab[]; title: MessageId; tablist: MessageId; region: string }> = {
  library: { tabs: LIBRARY_TABS, title: "area.library", tablist: "tabs.library", region: "素材工作区" },
  automation: { tabs: AUTOMATION_TABS, title: "area.automation", tablist: "tabs.automation", region: "自动化工作区" },
};
const cardStyle: CSSProperties = { border: "1px solid var(--line-1)", borderRadius: "var(--r-md)", background: "var(--ink-2)", overflow: "hidden" };
const toolCardStyle: CSSProperties = { ...cardStyle, padding: 22, display: "grid", gap: 14 };

class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div role="alert" className="workspace-error">{t("workspace.failed")}<button type="button" className="app-ghost" onClick={() => window.location.reload()}>{t("workspace.reload")}</button></div>
      : this.props.children;
  }
}
function LoadWorkspace({ children }: { children: ReactNode }) {
  return <WorkspaceBoundary><Suspense fallback={<p role="status" className="workspace-loading">{t("workspace.loading")}</p>}>{children}</Suspense></WorkspaceBoundary>;
}

function toolContent(tab: ToolTab) {
  switch (tab) {
    case "create":
      return <MediaWorkshop />;
    case "brand":
      return (
        <div className="tool-grid">
          <BrandStudio />
          <VoiceReview cardStyle={toolCardStyle} />
        </div>
      );
    case "examples":
      return <ExampleTools />;
    case "canvas":
      return <GenCanvasBoard />;
    case "skills":
      return <SkillCatalog />;
    case "batch":
      return <BatchWorkshop />;
    case "tasks":
      return <TaskCenter />;
  }
}

const studioOf = (route: AppRoute): StudioLocation | undefined => route.area !== "studio" ? undefined
  : route.view === "workspace" ? { view: "workspace", ...(route.projectId ? { projectId: route.projectId } : {}) } : { view: route.view };
const studioRoute = (location: StudioLocation): AppRoute => location.view === "workspace"
  ? { area: "studio", view: "workspace", ...(location.projectId ? { projectId: location.projectId } : {}) }
  : { area: "studio", view: location.view };
const sameStudio = (a: StudioLocation, b: StudioLocation) => formatRoute(studioRoute(a)) === formatRoute(studioRoute(b));

function readTheme(): Theme {
  try { return localStorage.getItem("glint:theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
}

export const App: React.FC = () => {
  const [location, setLocation] = useHashLocation();
  const route = useMemo(() => parseRoute(location), [location]);
  const routeRef = useRef(route); routeRef.current = route;
  const [navigationError, setNavigationError] = useState("");
  const [studioMounted, setStudioMounted] = useState(route.area !== "container");
  const [containerLocation, setContainerLocation] = useState<Extract<AppRoute, { area: "container" }> | undefined>(() => route.area === "container" ? route : undefined);
  const go = useCallback((next: AppRoute, replace = false) => {
    try { if (routeRef.current.area === "container") assertAllAuthoringCanLeave(); setNavigationError(""); if (formatRoute(next) !== formatRoute(routeRef.current)) setLocation(formatRoute(next), { replace }); } catch (error) { setNavigationError((error as Error).message); }
  }, [setLocation]);

  useEffect(() => {
    if (route.area === "studio") setStudioMounted(true);
    if (route.area !== "container" || formatRoute(route) === (containerLocation ? formatRoute(containerLocation) : "")) return;
    try { assertAllAuthoringCanLeave(); setContainerLocation(route); setNavigationError(""); }
    catch (error) { setNavigationError((error as Error).message); if (containerLocation) setLocation(formatRoute(containerLocation), { replace: true }); }
  }, [route, containerLocation, setLocation]);

  // Studio location: the hash asks, IdeaStudio answers with where it really is.
  const lastStudio = useRef<StudioLocation>({ view: "home" });
  const nonce = useRef(0);
  const [studioRequest, setStudioRequest] = useState<StudioRequest | undefined>(() => {
    const target = studioOf(route);
    return target && !sameStudio(target, lastStudio.current) ? { ...target, nonce: ++nonce.current } : undefined;
  });
  useEffect(() => {
    const target = studioOf(route);
    if (!target || sameStudio(target, lastStudio.current)) return;
    setStudioRequest(current => current && sameStudio(current, target) ? current : { ...target, nonce: ++nonce.current });
  }, [route]);
  const onStudioLocation = useCallback((next: StudioLocation) => {
    const previous = lastStudio.current;
    lastStudio.current = next;
    if (routeRef.current.area !== "studio") return;
    go(studioRoute(next), previous.view === "workspace" && next.view === "workspace");
  }, [go]);

  // Areas mount on first visit and then stay mounted, so drafts survive navigation.
  const [visitedTools, setVisitedTools] = useState<Set<ToolTab>>(() => new Set());
  const [lastTab, setLastTab] = useState<Record<ToolArea, ToolTab>>({ library: "create", automation: "canvas" });
  const [settingsMounted, setSettingsMounted] = useState(route.area === "settings");
  const [nleMounted, setNleMounted] = useState(route.area === "edit");
  const [nleRequest, setNleRequest] = useState<{ sourceId: string; nonce: number }>();
  const beforeEdit = useRef<AppRoute>({ area: "studio", view: "home" });
  useEffect(() => {
    if (route.area === "library" || route.area === "automation") {
      const tab = route.tab;
      setVisitedTools(current => current.has(tab) ? current : new Set([...current, tab]));
      setLastTab(current => current[route.area as ToolArea] === tab ? current : { ...current, [route.area]: tab });
    }
    if (route.area === "settings") setSettingsMounted(true);
    if (route.area === "edit") setNleMounted(true);
    else if (route.area !== "docs") beforeEdit.current = route;
  }, [route]);

  const openArea = (area: RailArea) => {
    if (area === "studio") go(studioRoute(lastStudio.current));
    else if (area === "library" || area === "automation") go({ area, tab: lastTab[area] } as AppRoute);
    else go({ area } as AppRoute);
  };

  const [recoveryError, setRecoveryError] = useState("");
  const [localDownload, setLocalDownload] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/download/client/status", { signal: controller.signal }).then(response => response.ok ? response.json() : null)
      .then(value => { if (!controller.signal.aborted) setLocalDownload(value?.available === true); })
      .catch(() => { /* Keep the public release link when the local download is unavailable. */ });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("glint:theme", theme); } catch { /* Editing works without storage. */ }
  }, [theme]);

  const docsOpen = route.area === "docs";
  const area = route.area;
  const toolArea: ToolArea | undefined = area === "library" || area === "automation" ? area : undefined;
  const bleed = area === "studio" || area === "edit" || area === "container";

  // Command palette: opened from the rail or Ctrl/⌘+K; commands are built when it opens so
  // the recent-works list is always current.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      setPaletteOpen(open => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    if (!paletteOpen) return [];
    const go_ = t("palette.group.go");
    const commands: PaletteCommand[] = [
      { id: "go-project", label: t("nav.project"), group: go_, keywords: "project home 工程 作品", run: () => openArea("studio") },
      { id: "go-library", label: t("nav.library"), group: go_, keywords: "assets media 素材", run: () => go({ area: "library", tab: lastTab.library } as AppRoute) },
      { id: "go-automation", label: t("nav.automation"), group: go_, keywords: "automation", run: () => go({ area: "automation", tab: lastTab.automation } as AppRoute) },
      { id: "go-edit", label: t("nav.edit"), group: go_, keywords: "timeline nle editor 时间线 剪辑", run: () => go({ area: "edit" }) },
      { id: "go-settings", label: t("nav.settings"), group: go_, keywords: "settings model 模型 连接", run: () => go({ area: "settings" }) },
      ...LIBRARY_TABS.map(tab => ({ id: `tab-${tab}`, label: t(`tab.${tab}` as MessageId), group: go_, keywords: t("nav.library"), run: () => go({ area: "library", tab }) })),
      ...AUTOMATION_TABS.map(tab => ({ id: `tab-${tab}`, label: t(`tab.${tab}` as MessageId), group: go_, keywords: t("nav.automation"), run: () => go({ area: "automation", tab }) })),
    ];
    let recent: PaletteCommand[] = [];
    try {
      recent = readSavedProjects().slice(0, 8).map(saved => ({ id: `recent-${saved.id}`, label: saved.name, group: t("palette.group.recent"), keywords: "作品 工程 recent",
        run: () => go(saved.project ? { area: "studio", view: "workspace", projectId: saved.project.id } : { area: "studio", view: "home" }) }));
    } catch { /* A broken saved-work list must not block navigation commands. */ }
    return [...commands, ...recent,
      { id: "action-new", label: t("palette.action.home"), group: t("palette.group.action"), keywords: "new create 创作 开始", run: () => go({ area: "studio", view: "home" }) },
      { id: "action-docs", label: t("palette.action.docs"), group: t("palette.group.action"), keywords: "help docs 帮助 文档", run: () => go({ area: "docs", rest: "" }) },
      { id: "action-theme", label: t(theme === "dark" ? "palette.action.theme.light" : "palette.action.theme.dark"), group: t("palette.group.action"), keywords: "theme dark light 主题 外观 深色 浅色", run: () => setTheme(theme === "dark" ? "light" : "dark") },
    ];
    // The list is rebuilt on every open (see the paletteOpen guard), so these closures are fresh.
  }, [paletteOpen, theme, lastTab]);

  return <>
    <a className="g-skip-link" href="#app-main" onClick={event => { event.preventDefault(); document.getElementById("app-main")?.focus(); }}>{t("nav.skip")}</a>
    {docsOpen && <LoadWorkspace><DocsPage localDownload={localDownload} /></LoadWorkspace>}
    <div className="app-shell app-navigation" data-area={area} hidden={docsOpen}>
      <Rail active={railArea(route)} theme={theme} localDownload={localDownload}
        onHome={() => go({ area: "studio", view: "home" })} onArea={openArea} onTheme={setTheme} onSearch={() => setPaletteOpen(true)} />
      <div className="workspace-body">
        <OfflineStatus />
        {toolArea && <header className="workspace-bar">
          <h1 className="workspace-bar-title">{t(TOOL_GROUPS[toolArea].title)}</h1>
          <ToolTabs area={toolArea} active={route.area === toolArea ? route.tab : lastTab[toolArea]} onSelect={tab => go({ area: toolArea, tab } as AppRoute)} />
        </header>}
        {area === "settings" && <header className="workspace-bar"><h1 className="workspace-bar-title">{t("area.settings")}</h1></header>}
        <main className="workspace-main" id="app-main" tabIndex={-1} data-bleed={bleed} hidden={area === "edit"}>
          <section className="workspace-page workspace-page--studio" aria-label="项目工作区" hidden={area !== "studio"}>
            <button className="g-btn g-btn--quiet" type="button" onClick={() => go({ area: "container" })}>{t("container.open")}</button>
            <AuthoringVisibility active={area === "studio"}>
              {studioMounted && <>
              <IdeaStudio cardStyle={cardStyle} location={studioRequest} onLocationChange={onStudioLocation}
                onOpenTimeline={sourceId => { setNleRequest({ sourceId, nonce: Date.now() }); setNleMounted(true); go({ area: "edit" }); }}
                onOpenSettings={() => go({ area: "settings" })} /></>}
            </AuthoringVisibility>
          </section>
          {navigationError && <p role="alert">{navigationError}</p>}
          <section className="workspace-page workspace-page--studio" hidden={area !== "container"}>
            {containerLocation && <LoadWorkspace><ContainerWorkspace projectId={containerLocation.projectId} objectId={containerLocation.objectId} active={area === "container"} onOpen={(projectId, objectId) => go({ area: "container", projectId, objectId })} /></LoadWorkspace>}
          </section>
          {(Object.keys(TOOL_GROUPS) as ToolArea[]).map(group => <section key={group} className="workspace-page workspace-page--tools" aria-label={TOOL_GROUPS[group].region} hidden={area !== group}>
            {TOOL_GROUPS[group].tabs.map(tab => <div key={tab} className="workspace-tool-panel" role="tabpanel" id={`tool-panel-${tab}`} aria-labelledby={`tool-tab-${tab}`} tabIndex={0} hidden={lastTab[group] !== tab}>
              {visitedTools.has(tab) && <LoadWorkspace>{toolContent(tab)}</LoadWorkspace>}
            </div>)}
          </section>)}
          <section className="workspace-page workspace-page--settings" aria-label="设置工作区" hidden={area !== "settings"}>
            {settingsMounted && <LoadWorkspace><ModelSettings /></LoadWorkspace>}
            <div className="settings-legacy">
              <button className="g-btn" type="button" onClick={() => { try { assertAllAuthoringCanLeave(); window.location.hash = "/recovery"; window.location.reload(); } catch (error) { setRecoveryError(error instanceof Error ? error.message : t("settings.legacy.blocked")); } }}>{t("settings.legacy")}</button>
              {recoveryError && <p role="alert">{recoveryError}</p>}
            </div>
          </section>
        </main>
        <div className="workspace-nle" aria-label="剪辑工作区" hidden={area !== "edit"}>
          {nleMounted && <LoadWorkspace><NleEditor openRequest={nleRequest} active={area === "edit"} onClose={() => go(beforeEdit.current)} /></LoadWorkspace>}
        </div>
      </div>
    </div>
    {paletteOpen && <Suspense fallback={null}><CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} /></Suspense>}
  </>;
};

function ToolTabs({ area, active, onSelect }: { area: ToolArea; active: ToolTab; onSelect(tab: ToolTab): void }) {
  const tabs = TOOL_GROUPS[area].tabs;
  return <div className="tool-tabs workspace-tabs" role="tablist" aria-label={t(TOOL_GROUPS[area].tablist)}>
    {tabs.map((tab, index) => <button key={tab} type="button" role="tab" className="tool-tab" id={`tool-tab-${tab}`} aria-selected={active === tab} aria-controls={`tool-panel-${tab}`} tabIndex={active === tab ? 0 : -1}
      onKeyDown={event => {
        const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1]
          : event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : undefined;
        if (next) { event.preventDefault(); document.getElementById(`tool-tab-${next}`)?.focus(); }
      }}
      onClick={() => onSelect(tab)}>{t(`tab.${tab}` as MessageId)}</button>)}
  </div>;
}
