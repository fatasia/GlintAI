import { useMemo } from "react";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";

export type TtsCostKind = "silent" | "local" | "edge" | "paid";

export interface TtsEngine {
  id: string;
  label: string;
  cost: TtsCostKind;
  behavior: string;
}

export interface TtsCost {
  kind: TtsCostKind;
  label: string;
  detail: string;
  requiresConfirmation: boolean;
}

/** Engine labels double as the source of truth for the picker and the pre-flight summary. */
export const TTS_ENGINES: readonly TtsEngine[] = [
  { id: "mock", label: "无声草稿 · 最快", cost: "silent", behavior: "不调用配音服务，不联网，不产生费用。" },
  { id: "sapi", label: "Windows 系统配音 · 离线", cost: "local", behavior: "使用 Windows 系统音色在本机合成，不联网，不产生费用。" },
  { id: "edge", label: "Edge 配音 · 联网", cost: "edge", behavior: "旁白文本会发送到 Microsoft 在线服务合成；配音免费，但会联网。" },
  { id: "qwen", label: "Qwen 本地克隆", cost: "local", behavior: "使用本机 Qwen 模型与已授权参考音频合成，不联网，不产生费用。" },
  { id: "openai", label: "OpenAI 兼容配音", cost: "paid", behavior: "旁白文本会发送到你配置的 OpenAI 兼容服务。" },
  { id: "elevenlabs", label: "ElevenLabs · 音色与精准字幕", cost: "paid", behavior: "旁白文本会发送到 ElevenLabs 云端服务。" },
  { id: "fish", label: "Fish Audio · 多语言配音", cost: "paid", behavior: "旁白文本会发送到 Fish Audio 云端服务。" },
  { id: "minimax", label: "MiniMax · 高品质配音", cost: "paid", behavior: "旁白文本会发送到 MiniMax 云端服务。" },
  { id: "gateway", label: "媒体网关 · 云端配音", cost: "paid", behavior: "旁白文本会发送到已配置的媒体网关。" },
];

export const ENCODING_OPTIONS = [
  { id: "draft", label: "预览 · 半尺寸 / 快速" },
  { id: "compact", label: "紧凑 · 全尺寸 / CRF24" },
  { id: "balanced", label: "均衡 · 全尺寸 / CRF20" },
  { id: "quality", label: "母版 · 全尺寸 / CRF16" },
] as const;

export function ttsLabel(engine: string): string {
  return TTS_ENGINES.find(option => option.id === engine)?.label ?? engine;
}

export function encodingLabel(encoding: string): string {
  return ENCODING_OPTIONS.find(option => option.id === encoding)?.label ?? encoding;
}

/**
 * Cost is a property of where the narration is synthesized, not of the export
 * profile. Unknown engines are treated as possibly billable rather than free.
 */
export function ttsCost(engine: string): TtsCost {
  const option = TTS_ENGINES.find(item => item.id === engine);
  if (!option) return {
    kind: "paid",
    label: "可能计费：未知配音引擎",
    detail: "未知配音引擎可能调用第三方服务。本机未配置价格表，费用由服务商决定。",
    requiresConfirmation: true,
  };
  if (option.cost === "paid") return {
    kind: "paid",
    label: "可能计费：云端配音",
    detail: `${option.behavior}本机未配置价格表，费用由服务商决定。`,
    requiresConfirmation: true,
  };
  if (option.cost === "silent") return {
    kind: "silent",
    label: "免费：无声草稿（mock）",
    detail: option.behavior,
    requiresConfirmation: false,
  };
  if (option.cost === "edge") return {
    kind: "edge",
    label: "免费：Edge 配音，但会联网",
    detail: option.behavior,
    requiresConfirmation: false,
  };
  return { kind: "local", label: "免费：本机配音", detail: option.behavior, requiresConfirmation: false };
}

const labelStyle = { color: "#8fa2b8", fontSize: 13 };
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
  return <section aria-label="出片前预检" style={{ display: "grid", gap: 12, minWidth: 0, border: "1px solid #35414e", borderRadius: 10, padding: 16, background: "#101924" }}>
    <div>
      <strong>出片前预检</strong>
      <small style={{ display: "block", color: "#a7b4c4" }}>开始制作前核对本次任务的分镜、时长、配音与导出规格；费用与联网行为按实际选择显示。</small>
    </div>
    <dl aria-label="预检摘要" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,160px),1fr))", gap: 12, margin: 0 }}>
      <div><dt style={labelStyle}>分镜</dt><dd aria-label="分镜数" style={valueStyle}>{sceneCount}</dd></div>
      <div><dt style={labelStyle}>预计总时长</dt><dd aria-label="预计总时长" style={valueStyle}>{duration}</dd></div>
      <div><dt style={labelStyle}>配音</dt><dd aria-label="配音引擎" style={valueStyle}>{ttsLabel(tts)}</dd></div>
      <div><dt style={labelStyle}>导出规格</dt><dd aria-label="导出规格" style={valueStyle}>{encodingLabel(encoding)}</dd></div>
    </dl>
    <div role="group" aria-label="费用与联网状态" style={{ display: "grid", gap: 6, borderTop: "1px solid #304053", paddingTop: 12 }}>
      <strong aria-label="费用状态" style={{ color: cost.kind === "paid" ? "#f0c98a" : "#9fd3a8" }}>{cost.label}</strong>
      <p style={{ margin: 0, color: "#a7b4c4", overflowWrap: "anywhere" }}>{cost.detail}</p>
    </div>
    {cost.requiresConfirmation && <label style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "#f0c98a" }}>
      <input aria-label="我确认可能产生费用" type="checkbox" checked={confirmed} disabled={disabled} onChange={event => onConfirmationChange(event.target.checked)} />
      <span>我确认可能产生费用</span>
    </label>}
    {cost.requiresConfirmation && !confirmed && <small role="status" style={{ color: "#f0c98a" }}>未勾选确认时，制作按钮保持禁用。</small>}
    {!project && <small style={{ color: "#a7b4c4" }}>分镜与时长将在提交后按输入资料编排；现在无法预判。</small>}
  </section>;
}
