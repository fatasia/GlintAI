import { useMemo } from "react";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";

import { ttsCost, ttsLabel, encodingLabel } from "./tts-cost";
export { ttsCost, ttsLabel, encodingLabel, TTS_ENGINES, ENCODING_OPTIONS, type TtsCostKind, type TtsCost, type TtsEngine } from "./tts-cost";

const labelStyle = { color: "var(--muted)", fontSize: 13 };
const valueStyle = { margin: 0, fontWeight: 600, overflowWrap: "anywhere" as const };

export function RenderSummary({ project, tts, encoding, confirmed, disabled = false, onConfirmationChange }: {
  project: SceneScriptProject | null;
  tts: string;
  encoding: string;
  confirmed: boolean;
  disabled?: boolean;
  onConfirmationChange(checked: boolean): void;
}) {
  const timeline = useMemo(() => project ? buildTimeline(project) : null, [project]);
  const cost = ttsCost(tts);
  const sceneCount = project ? `${project.scenes.length} 个` : "待编排";
  const duration = timeline ? `${(timeline.totalMs / 1000).toFixed(1)} 秒` : "待编排";
  return <section aria-label="出片前预检" className="render-summary" style={{ display: "grid", gap: 12, minWidth: 0, border: "1px solid var(--line-2)", borderRadius: 10, padding: 16, background: "var(--ink-2)" }}>
    <div>
      <strong>出片前预检</strong>
      <small style={{ display: "block", color: "var(--muted)" }}>开始制作前核对本次任务的分镜、时长、配音与导出规格；费用与联网行为按实际选择显示。</small>
    </div>
    <dl aria-label="预检摘要" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,160px),1fr))", gap: 12, margin: 0 }}>
      <div><dt style={labelStyle}>分镜</dt><dd aria-label="分镜数" style={valueStyle}>{sceneCount}</dd></div>
      <div><dt style={labelStyle}>预计总时长</dt><dd aria-label="预计总时长" style={valueStyle}>{duration}</dd></div>
      <div><dt style={labelStyle}>配音</dt><dd aria-label="配音引擎" style={valueStyle}>{ttsLabel(tts)}</dd></div>
      <div><dt style={labelStyle}>导出规格</dt><dd aria-label="导出规格" style={valueStyle}>{encodingLabel(encoding)}</dd></div>
    </dl>
    <div role="group" aria-label="费用与联网状态" style={{ display: "grid", gap: 6, borderTop: "1px solid var(--hair)", paddingTop: 12 }}>
      <strong aria-label="费用状态" style={{ color: cost.kind === "paid" ? "var(--warn)" : "var(--ok)" }}>{cost.label}</strong>
      <p style={{ margin: 0, color: "var(--muted)", overflowWrap: "anywhere" }}>{cost.detail}</p>
    </div>
    {cost.requiresConfirmation && <label style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "#f0c98a" }}>
      <input aria-label="我确认可能产生费用" type="checkbox" checked={confirmed} disabled={disabled} onChange={event => onConfirmationChange(event.target.checked)} />
      <span>我确认可能产生费用</span>
    </label>}
    {cost.requiresConfirmation && !confirmed && <small role="status" style={{ color: "#f0c98a" }}>未勾选确认时，制作按钮保持禁用。</small>}
    {!project && <small style={{ color: "#a7b4c4" }}>分镜与时长将在提交后按输入资料编排；现在无法预判。</small>}
  </section>;
}
