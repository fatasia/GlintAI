import { applicationUrl } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { exportDesignDocument, type DesignExportFormat, type DesignExportResult } from "./design-export-client";
import type { DesignDocument } from "./design-artifacts";
import type { BrandTheme } from "./design-brand";

const FORMATS: Array<{ id: DesignExportFormat; label: string }> = [
  { id: "html", label: "HTML 页面" }, { id: "png", label: "当前页 PNG" }, { id: "pdf", label: "整份 PDF" },
  { id: "pptx", label: "可编辑 PPTX" }, { id: "zip", label: "源码与素材 ZIP" },
];
export function DesignExportPanel({ document, brand = null, onClose }: { document: DesignDocument; brand?: BrandTheme | null; onClose(): void }) {
  const [format, setFormat] = useState<DesignExportFormat>("html"), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DesignExportResult | null>(null), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setResult(null);
    try { const output = await exportDesignDocument(document, format, controller.signal, brand); if (!controller.signal.aborted) setResult(output); }
    catch (cause) { setError(controller.signal.aborted ? "已取消导出。" : cause instanceof Error ? cause.message : "导出失败，请重试。"); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const close = () => { active.current?.abort(); onClose(); };
  return <section className="design-export-panel" role="dialog" aria-modal="true" aria-label="导出设计" onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <header><div><h2>导出设计</h2><p>{document.title} · {document.pages.length} 页</p></div><button type="button" onClick={close}>关闭</button></header>
    <label>格式<select aria-label="设计导出格式" value={format} disabled={busy} onChange={event => { setFormat(event.target.value as DesignExportFormat); setResult(null); }}>{FORMATS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <p className="design-hint">HTML 和 ZIP 保留导出副本源码；品牌变量仅加入导出副本，不改当前设计。PPTX 的文字、图片和基础形状可继续编辑，复杂效果会单独转成图片。</p>
    <div className="design-panel-actions"><button type="button" className="design-primary" disabled={busy} onClick={() => void run()}>{busy ? "正在导出…" : "开始导出"}</button>{busy && <button type="button" onClick={() => active.current?.abort()}>取消导出</button>}</div>
    {busy && <p role="status">正在准备文件，请稍候…</p>}
    {error && <p role="alert" className="design-error">{error}</p>}
    {result && <div className="design-export-result"><a href={applicationUrl(result.url)} download={result.file}>下载 {format.toUpperCase()}（{(result.bytes / 1024).toFixed(1)} KB）</a>
      {result.editableElements !== undefined && <p>{result.editableElements} 个可编辑元素</p>}
      {result.warnings.length > 0 && <details><summary>查看导出说明</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </div>}
  </section>;
}
