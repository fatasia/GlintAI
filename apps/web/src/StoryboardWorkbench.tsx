import { useStoryboardPrevizEntry } from "./storyboard-previz-entry";
import { t } from "./ui/i18n";
import { lazy, Suspense, useMemo, useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { applyIdentities, buildSeries, checkContinuity, ScreenplayError, shotTable, shotTableCsv, type MgKind, type Series, type ShotEngine } from "@glintai/composer/drama-series";
import { downloadText } from "./editor-model";
import type { ScriptDocument } from "./script-documents";
import { applyEngineOverrides, readStoryboardPrefs, shotKey, writeStoryboardPrefs, type StoryboardPrefs } from "./storyboard-prefs";
import "./storyboard.css";
import { StoryboardApply } from "./StoryboardApply";
import { hasAppliedStoryboard, projectStoryboardChoices } from "./storyboard-project";
const StoryboardPreviz = lazy(() => import("./StoryboardPreviz"));
const ENGINE_LABEL: Record<ShotEngine, string> = { mg: "MG", aigc: "AIGC" };
const MG_KINDS: ReadonlyArray<{ id: MgKind; label: string }> = [
  { id: "title", label: "标题卡" }, { id: "bullets", label: "要点" }, { id: "definition", label: "定义" }, { id: "quote", label: "引语 / 对白" },
  { id: "comparison", label: "对比" }, { id: "chart", label: "图表" }, { id: "diagram", label: "图解" }, { id: "code", label: "代码" }, { id: "html", label: "HTML" }, { id: "three", label: "3D 场景" },
];
const SIZE_LABEL = { wide: "远景", medium: "中景", close: "特写", "over-shoulder": "过肩", insert: "细节" } as const;
export interface StoryboardWorkbenchProps {
  project: SceneScriptProject;
  screenplays: readonly ScriptDocument[];
  onOpenScript(): void;
  onApply?(project: SceneScriptProject): void;
}
export function StoryboardWorkbench({ project, screenplays, onOpenScript, onApply }: StoryboardWorkbenchProps) {
  const previz = useStoryboardPrevizEntry();
  const storageId = (documentId: string) => screenplays.length > 1 ? `${project.id}:${documentId}` : project.id;
  const [prefs, setPrefs] = useState<StoryboardPrefs>(() => readStoryboardPrefs(storageId(screenplays[0]?.id ?? "")));
  const [docId, setDocId] = useState(screenplays[0]?.id ?? "");
  const [episodeId, setEpisodeId] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const doc = screenplays.find(entry => entry.id === docId) ?? screenplays[0];
  const update = (next: StoryboardPrefs) => { setPrefs(next); setSaveFailed(!writeStoryboardPrefs(storageId(doc?.id ?? ""), next)); };
  const built = useMemo((): { series: Series } | { error: string } | null => {
    if (!doc) return null;
    try {
      const base = buildSeries(doc.content, { engine: prefs.defaultEngine ?? "mg", id: project.id, title: project.title || "未命名工程", aspect: project.aspect });
      if (!prefs.defaultEngine && !hasAppliedStoryboard(base, project, doc.id)) return null;
      return { series: applyEngineOverrides(projectStoryboardChoices(applyIdentities(base, project.assets ?? []), project, doc.id), prefs.overrides) };
    } catch (error) {
      return { error: error instanceof ScreenplayError ? (error.issues.join("；") || error.message) : error instanceof Error ? error.message : "无法解析剧本" };
    }
  }, [doc, prefs, project]);

  if (!screenplays.length || !doc) {
    return <section className="storyboard" aria-label="分镜工作区"><div className="storyboard-empty">
      <h2>还没有剧本</h2>
      <p>分镜由「剧本」文档拆出：场景标题、角色名、对白和动作。先在脚本视图里新建一份剧本。</p>
      <button type="button" className="g-btn g-btn--primary" onClick={onOpenScript}>去写剧本</button>
    </div></section>;
  }

  if (!prefs.defaultEngine && !built) {
    return <section className="storyboard" aria-label="分镜工作区"><div className="storyboard-empty">
      <h2>这个系列默认怎么出画面？</h2>
      <p>两种方式对等，每个镜头之后都能单独改，也可以在同一集里混用。</p>
      <div className="storyboard-choices" role="group" aria-label="默认渲染方式">
        <button type="button" className="storyboard-choice" onClick={() => update({ ...prefs, defaultEngine: "mg" })}>
          <strong>MG 动态图形</strong>
          <span>Glint 在本机用文字、图表、图解、代码和 3D 场景渲染。免费，逐帧可复现，文字和数字可以精确修改。</span>
        </button>
        <button type="button" className="storyboard-choice" onClick={() => update({ ...prefs, defaultEngine: "aigc" })}>
          <strong>AIGC 生成画面</strong>
          <span>由图像和视频模型生成画面。适合写实场景和角色表演，需要配置模型，并按用量计费。</span>
        </button>
      </div>
    </div></section>;
  }

  if (!built || "error" in built) {
    return <section className="storyboard" aria-label="分镜工作区"><div className="storyboard-empty" role="alert">
      <h2>剧本还不能拆成分镜</h2>
      <p>{built && "error" in built ? built.error : ""}</p>
      <p>场景标题支持「第一场 茶馆 内 日」「INT. CAFE - DAY」等写法；对白写成「角色：台词」。</p>
      <button type="button" className="g-btn" onClick={onOpenScript}>回到脚本</button>
    </div></section>;
  }

  const { series } = built;
  const episode = series.episodes.find(entry => entry.id === episodeId) ?? series.episodes[0]!;
  const allShots = series.episodes.flatMap(entry => entry.scenes.flatMap(scene => scene.shots));
  const mgCount = allShots.filter(shot => shot.engine === "mg").length;
  const aigcCount = allShots.length - mgCount;
  const totalSeconds = Math.round(allShots.reduce((sum, shot) => sum + shot.durationMs, 0) / 100) / 10;
  const issues = checkContinuity(series);
  const errors = issues.filter(issue => issue.level === "error");

  const setEngine = (fingerprint: string, index: number, sceneId: string, engine: ShotEngine, mgKind?: MgKind) => {
    const key = shotKey(fingerprint, index, sceneId);
    update({ ...prefs, overrides: { ...prefs.overrides, [key]: engine === "mg" ? { engine, ...(mgKind ? { mgKind } : {}) } : { engine } } });
  };

  const exportCsv = () => downloadText(`${project.id}-${episode.id}-shots.csv`, `\uFEFF${shotTableCsv(shotTable(series, episode.id))}`, "text/csv;charset=utf-8");

  return <section className="storyboard" aria-label="分镜工作区">
    <header className="storyboard-head">
      <div className="storyboard-title">
        <h2>分镜</h2>
        <span className="g-num">{series.episodes.length} 集 · {allShots.length} 镜 · {totalSeconds}s · MG {mgCount} / AIGC {aigcCount}</span>
      </div>
      <div className="storyboard-controls">
        {screenplays.length > 1 && <label>剧本<select aria-label="剧本文档" value={doc.id} onChange={event => { const id = event.target.value; previz.guard(() => { setDocId(id); setEpisodeId(""); setPrefs(readStoryboardPrefs(storageId(id))); previz.close(); }); }}>{screenplays.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>}
        <label>集<select aria-label="集" value={episode.id} onChange={event => { const id = event.target.value; previz.guard(() => { setEpisodeId(id); previz.close(); }); }}>{series.episodes.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
        <div className="g-seg" role="group" aria-label="新镜头默认方式">
          {(["mg", "aigc"] as const).map(engine => <button key={engine} type="button" aria-pressed={prefs.defaultEngine === engine} onClick={() => update({ ...prefs, defaultEngine: engine })}>{ENGINE_LABEL[engine]}</button>)}
        </div>
        <button type="button" className="g-btn g-btn--sm" onClick={exportCsv}>导出分镜表 CSV</button>
      </div>
    </header>
    {saveFailed && <p className="storyboard-note" role="status">浏览器存储不可用，渲染方式的选择不会保存。</p>}

    {previz.error && <p role="alert">{previz.error}</p>}{previz.selection && <Suspense fallback={<p>{t("previz.loading")}</p>}><StoryboardPreviz key={`${project.id}:${doc.id}`} series={series} sceneId={previz.selection.sceneId} shotId={previz.selection.shotId} projectId={project.id} onClose={previz.close} /></Suspense>}
    <div className="storyboard-body">
      <div className="storyboard-table-wrap">
        <table className="storyboard-table" aria-label={`${episode.title} 分镜表`}>
          <thead><tr><th scope="col">镜</th><th scope="col">渲染方式</th><th scope="col">景别</th><th scope="col">秒</th><th scope="col">说话人</th><th scope="col">台词 / 动作</th></tr></thead>
          <tbody>{episode.scenes.map(scene => [
            <tr key={scene.id} className="storyboard-scene"><th scope="rowgroup" colSpan={6}>{scene.heading}</th></tr>,
            ...scene.shots.map(shot => {
              const speakers = shot.dialogue.map(line => series.characters.find(character => character.id === line.characterId)?.name ?? "").join("、");
              return <tr key={shot.id}>
                <td className="g-num">{shot.index}<button type="button" className="g-btn g-btn--sm" onClick={() => previz.open(scene.id, shot.id)}>{t("previz.open")}</button></td>
                <td><div className="storyboard-engine">
                  <div className="g-seg" role="group" aria-label={`镜头 ${shot.id} 渲染方式`}>
                    {(["mg", "aigc"] as const).map(engine => <button key={engine} type="button" aria-pressed={shot.engine === engine} onClick={() => setEngine(scene.fingerprint, shot.index, scene.id, engine, engine === "mg" ? shot.mgKind : undefined)}>{ENGINE_LABEL[engine]}</button>)}
                  </div>
                  {shot.engine === "mg" && <select aria-label={`镜头 ${shot.id} MG 场景类型`} value={shot.mgKind ?? "title"} onChange={event => setEngine(scene.fingerprint, shot.index, scene.id, "mg", event.target.value as MgKind)}>{MG_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select>}
                </div></td>
                <td>{SIZE_LABEL[shot.size]}</td>
                <td className="g-num">{Math.round(shot.durationMs / 100) / 10}</td>
                <td>{speakers}</td>
                <td className="storyboard-line">{shot.dialogue.map(line => line.line).join(" ") || shot.action}</td>
              </tr>;
            }),
          ])}</tbody>
        </table>
      </div>

      <aside className="storyboard-side" aria-label="分镜检查与成本">
        <StoryboardApply key={`${doc.id}:${episode.id}`} series={series} episodeId={episode.id} documentId={doc.id} project={project} onApply={onApply} />
        <section aria-label="费用">
          <h3>费用</h3>
          <p>MG {mgCount} 镜：<strong>¥0</strong>，本机渲染。</p>
          <p>{aigcCount ? `AIGC ${aigcCount} 镜：还没有配置图像和视频模型的单价，暂时无法估价。` : "没有 AIGC 镜头。"}</p>
        </section>
        <section aria-label="角色">
          <h3>角色</h3>
          {series.characters.length ? <ul>{series.characters.map(character => {
            const look = character.looks[0]!;
            const state = look.approved ? "已定稿" : look.prompt ? "有描述，未定稿" : "还没有角色资产";
            return <li key={character.id}><span>{character.name}</span><small data-state={look.approved ? "ok" : "todo"}>{state}</small></li>;
          })}</ul> : <p>剧本里没有识别到角色。</p>}
          <p className="storyboard-note">角色造型在「作品视图 → 属性 → 生成 → 角色资产」中建立并定稿；只有 AIGC 镜头需要它。</p>
        </section>
        <section aria-label="连续性检查">
          <h3>连续性检查 {errors.length ? <small data-state="error">{errors.length} 个错误</small> : <small data-state="ok">无错误</small>}</h3>
          {issues.length ? <ul>{issues.slice(0, 40).map((issue, i) => <li key={`${issue.where}-${issue.code}-${i}`} data-level={issue.level}>{issue.message}</li>)}</ul> : <p>没有发现问题。</p>}
          {issues.length > 40 && <p className="storyboard-note">另有 {issues.length - 40} 条未显示。</p>}
        </section>
      </aside>
    </div>
  </section>;
}

export default StoryboardWorkbench;
