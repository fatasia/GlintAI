import { useMemo, useState } from "react";
import type { NleProject } from "@glintai/scenescript";
import { NlePreview } from "./NlePreview";
import { button, colors, field, label, select, sub } from "./ui-tokens";
import {
  applyCatalogChoice, catalogBlockReason, catalogPreviewProject, FILTER_CATALOG, TRANSITION_CATALOG,
  type CatalogChoice, type CatalogKind, type CatalogTarget,
} from "./nle-catalog";
import "./nle-catalog.css";

interface Props {
  project: NleProject;
  target: CatalogTarget | null;
  onApply(project: NleProject): void;
}

export function NleCatalog({ project, target, onApply }: Props) {
  const [kind, setKind] = useState<CatalogKind>("filter");
  const [presetId, setPresetId] = useState("silver-mono");
  const [query, setQuery] = useState("");
  const [strength, setStrength] = useState(100);
  const [edge, setEdge] = useState<"in" | "out">("in");
  const [durationMs, setDurationMs] = useState(500);
  const [fraction, setFraction] = useState(0.5);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const catalog = kind === "filter" ? FILTER_CATALOG : TRANSITION_CATALOG;
  const selected = catalog.find(item => item.id === presetId) ?? catalog[0]!;
  const visible = catalog.filter(item => `${item.name} ${item.description}`.includes(query.trim()));
  const choice: CatalogChoice = { kind, presetId: selected.id, strength, edge, durationMs };
  const reason = catalogBlockReason(project, target, kind);
  const preview = useMemo(() => target ? catalogPreviewProject(project, target, {
    kind, presetId: selected.id, strength, edge, durationMs,
  }) : null, [project, target?.trackId, target?.clipId, kind, selected.id, strength, edge, durationMs]);
  const clip = preview?.tracks[0]?.clips[0];
  const frameMs = clip ? kind === "filter" ? clip.durationMs / 2
    : edge === "in" ? Math.min(durationMs, clip.durationMs) * fraction
      : clip.durationMs - Math.min(durationMs, clip.durationMs) * (1 - fraction) : 0;
  const changeKind = (value: CatalogKind) => {
    setKind(value); setPresetId(value === "filter" ? "silver-mono" : "fade"); setQuery(""); setFeedback(null);
  };
  const apply = () => {
    if (!target || reason) return;
    try {
      onApply(applyCatalogChoice(project, target, choice));
      setFeedback({ error: false, text: `已应用${selected.name}，可用撤销恢复。` });
    } catch (error) { setFeedback({ error: true, text: error instanceof Error ? error.message : "应用失败，请重新选择片段。" }); }
  };

  return <section className="nle-catalog" aria-label="滤镜与转场库">
    <div role="group" aria-label="预设分类" className="nle-catalog-tabs">
      <button type="button" style={button} aria-pressed={kind === "filter"} onClick={() => changeKind("filter")}>滤镜</button>
      <button type="button" style={button} aria-pressed={kind === "transition"} onClick={() => changeKind("transition")}>转场</button>
    </div>
    <label style={label}>搜索预设<input aria-label="搜索滤镜与转场" type="search" value={query} style={field} onChange={event => setQuery(event.target.value)} /></label>
    {clip && preview ? <div className="nle-catalog-preview" aria-label="预设画面预览">
      <NlePreview project={preview} mediaAssetBase="/api/media/assets/" tMs={frameMs} playing={false} muted showMeter={false} />
    </div> : <p style={sub}>选择时间线片段后，这里会显示它的真实画面预览。</p>}
    <div className="nle-catalog-grid">
      {visible.map(item => <button type="button" key={item.id} title={item.description}
        style={button} aria-pressed={selected.id === item.id} aria-label={`预览${item.name}`}
        onClick={() => { setPresetId(item.id); setFeedback(null); }}>
        <strong>{item.name}</strong><span>{item.description}</span>
      </button>)}
    </div>
    {!visible.length && <p role="status" style={sub}>没有匹配的预设，请缩短关键词或清空搜索。</p>}
    <strong style={{ color: colors.text }}>{selected.name}</strong>
    <details><summary style={sub}>配方说明</summary><p style={sub}>{selected.description}</p></details>
    {kind === "filter" ? <label style={label}>滤镜强度 {strength}%
      <input aria-label="滤镜库强度" type="range" min={0} max={100} value={strength} onChange={event => setStrength(Number(event.target.value))} />
    </label> : <>
      <label style={label}>应用位置<select style={select} aria-label="转场库位置" value={edge} onChange={event => setEdge(event.target.value as "in" | "out")}><option value="in">入场</option><option value="out">出场</option></select></label>
      <label style={label}>转场时长 {durationMs} ms<input aria-label="转场库时长" type="range" min={100} max={5000} step={100} value={durationMs} onChange={event => setDurationMs(Number(event.target.value))} /></label>
      <label style={label}>预览进度 {Math.round(fraction * 100)}%<input aria-label="转场预览进度" type="range" min={0} max={1} step={0.01} value={fraction} onChange={event => setFraction(Number(event.target.value))} /></label>
    </>}
    <button type="button" style={button} disabled={Boolean(reason)} title={reason ?? "应用为一条撤销记录"} onClick={apply}>应用到选中片段</button>
    {reason && <p role="status" style={sub}>{reason}</p>}
    {feedback && <p role={feedback.error ? "alert" : "status"} style={sub}>{feedback.text}</p>}
    <small style={sub}>本地预设不调用模型。浏览不会修改工程；应用滤镜会替换片段原有效果，转场在片段内部完成。</small>
  </section>;
}
