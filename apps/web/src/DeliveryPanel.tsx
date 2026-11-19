import { applicationUrl } from "./app-url";
import { card, heading, sub } from "./ui-tokens";

/**
 * DELIVER-03 交付回执面板：成片导出回执（MP4 + 可选封面/字幕）的统一下载入口。
 * NleEditor 的导出回执已含 coverUrl（服务器 DELIVER-03 路由放行 jpg）；字幕与
 * 打包下载由 nle-delivery 的交付包（delivery.json + 三件套）提供 URL。
 * 本组件只读回执渲染链接，不持有状态，方便接到任何导出入口。
 */

export interface DeliveryReceipt {
  file: string;
  url: string;
  bytes?: number;
  /** nle-render 回执封面（服务器同目录 .cover.jpg）。 */
  coverUrl?: string;
  /** 交付包/字幕翻译产物（delivery 包 <base>.srt 或 glint srt 输出）。 */
  srtUrl?: string;
}

const link: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--line-1)",
  borderRadius: 9,
  padding: "8px 14px",
  font: "inherit",
  fontSize: 12.5,
  color: "var(--text-1, var(--paper))",
  textDecoration: "none",
  background: "var(--ink-2, var(--ink-2))",
};

const humanBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return ` · ${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

export function DeliveryPanel({ receipt }: { receipt: DeliveryReceipt | null }) {
  if (!receipt) return null;
  const items = [
    receipt.srtUrl ? { key: "srt", label: `下载字幕 SRT`, href: receipt.srtUrl, file: "srt" } : null,
    { key: "video", label: `下载成片 ${receipt.file.toLowerCase().endsWith(".webm") ? "WebM" : "MP4"}${humanBytes(receipt.bytes)}`, href: receipt.url, file: receipt.file },
    receipt.coverUrl ? { key: "cover", label: "下载封面 JPG", href: receipt.coverUrl, file: "cover.jpg" } : null,
  ].filter((item): item is { key: string; label: string; href: string; file: string } => Boolean(item));
  return (
    <div role="region" aria-label="交付下载" style={{ ...card, gap: 10 }}>
      <p style={heading}>交付包</p>
      <p style={sub}>下载已生成的文件；封面帧可在导出时指定时间点（默认首帧）。</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {items.map(item => (
          <a key={item.key} style={link} href={applicationUrl(item.href)} download={item.file}>{item.label}</a>
        ))}
      </div>
    </div>
  );
}
