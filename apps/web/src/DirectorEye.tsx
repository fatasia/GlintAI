import { useMemo } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { reviewProject, type ReviewSeverity } from "./director-eye";
import "./director-eye.css";

const LABEL: Record<ReviewSeverity, string> = { block: "必须改", warn: "建议改", note: "可以更好" };

/** The cut's own opinion: what reads as a slide, what is too even, what is missing. */
export function DirectorEye({ project, onSelectScene }: { project: SceneScriptProject; onSelectScene?(id: string): void }) {
  const report = useMemo(() => reviewProject(project), [project]);
  const ordered = [...report.findings].sort((a, b) => ({ block: 0, warn: 1, note: 2 }[a.severity] - { block: 0, warn: 1, note: 2 }[b.severity]));
  return <section className="director-eye" aria-label="审片官">
    <header className="director-eye-head">
      <div className="director-eye-score" data-band={report.score >= 85 ? "good" : report.score >= 65 ? "fair" : "poor"}>
        <strong className="g-num">{report.score}</strong><small>/ 100</small>
      </div>
      <div className="director-eye-verdict">
        <span className="g-label">审片官</span>
        <strong>{report.verdict}</strong>
        <small className="g-num">{report.stats.scenes} 镜 · {report.stats.seconds}s · 纯字卡 {report.stats.textOnly} · 运镜 {report.stats.movingScenes}</small>
      </div>
    </header>
    {ordered.length === 0
      ? <p className="director-eye-empty">没有发现结构性毛病。发布前还是建议自己完整看一遍。</p>
      : <ol className="director-eye-list">{ordered.map(finding => <li key={finding.id} data-severity={finding.severity}>
        <div className="director-eye-item-head"><span className="director-eye-tag">{LABEL[finding.severity]}</span><strong>{finding.title}</strong></div>
        <p>{finding.detail}</p>
        <p className="director-eye-action">{finding.action}</p>
        {finding.sceneId && onSelectScene && <button type="button" onClick={() => onSelectScene(finding.sceneId!)}>定位到这一镜</button>}
      </li>)}</ol>}
    <p className="director-eye-foot">按版式与节奏的确定性规则判断，不评价品牌调性；最终仍以你完整看一遍为准。</p>
  </section>;
}
