import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { chartScenesFromTable, type TableChartResult } from "@glintai/composer/chart-table";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

const button: CSSProperties = { border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--ink-3)", color: "var(--paper-dim)", padding: "8px 12px", font: "inherit", cursor: "pointer" };
type Preview = { name: string; title: string; source: string; result: TableChartResult | null };
const chartLabels: Record<string, string> = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图", scatter: "散点图", combo: "组合图" };

export function TableFileImport({ aspect, replacesProject, onProject }: { aspect: SceneScriptProject["aspect"]; replacesProject: boolean; onProject(project: SceneScriptProject, source: string): boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState("");
  const [workbook, setWorkbook] = useState<{ name: string; sheets: Array<{ name: string; text: string }> } | null>(null);
  const [sheet, setSheet] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { sequence.current++; active.current?.abort(); }, []);
  const updatePreview = (name: string, title: string, source: string) => {
    try {
      if (source.length > 12000) throw new Error("表格超过 12000 字，请先精简数据。");
      const result = chartScenesFromTable(source, { title: title || "表格图表", id: "chart" });
      setPreview({ name, title, source, result }); setError("");
    } catch (cause) { setPreview({ name, title, source, result: null }); setError(cause instanceof Error ? cause.message : "表格解析失败。"); }
  };
  const showSheet = (book: { name: string; sheets: Array<{ name: string; text: string }> }, index: string) => {
    setSheet(index); setPreview(null); setError("");
    const selected = book.sheets[Number(index)]; if (!selected) return;
    updatePreview(`${book.name} / ${selected.name}`, selected.name, selected.text);
  };
  const read = async (file?: File) => {
    active.current?.abort(); active.current = null; const current = ++sequence.current; setPreview(null); setWorkbook(null); setSheet(""); setLoading(false); setError("");
    if (!file) return;
    try {
      if (/\.xlsx$/i.test(file.name)) {
        if (file.size > 2 * 1024 * 1024) throw new Error("工作簿超过 2 MB，请先缩小文件。");
        setLoading(true); const controller = new AbortController(); active.current = controller;
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const response = await fetch("/api/source/workbook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64: btoa(binary) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) });
        const data = await response.json(); if (!response.ok) throw new Error(data?.error ?? "工作簿读取失败。");
        if (!Array.isArray(data.sheets) || !data.sheets.length || data.sheets.some((item: { name?: unknown; text?: unknown }) => typeof item.name !== "string" || typeof item.text !== "string")) throw new Error("工作簿内容无效。");
        if (sequence.current === current) { const book = { name: file.name, sheets: data.sheets }; setWorkbook(book); showSheet(book, "0"); }
        return;
      }
      if (!/\.(csv|tsv)$/i.test(file.name)) throw new Error("请选择 CSV、TSV 或 XLSX 表格。");
      if (file.size > 256 * 1024) throw new Error("表格超过 256 KB，请先缩小文件。");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const title = file.name.replace(/\.(csv|tsv)$/i, "") || "表格图表";
      if (sequence.current === current) updatePreview(file.name, title, text);
    } catch (cause) { if (sequence.current === current) setError(cause instanceof TypeError ? "文件不是有效的 UTF-8 文本。" : cause instanceof Error ? cause.message : "表格读取失败。"); }
    finally { if (sequence.current === current) { setLoading(false); active.current = null; } }
  };
  const charts = preview?.result?.scenes.filter(scene => scene.kind === "chart") ?? [];
  return <div aria-label="表格导入" style={{ display: "grid", gap: 8, minWidth: 0 }}>
    <label>导入数据图表（CSV / TSV / XLSX）<input aria-label="选择表格文件" type="file" accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ maxWidth: "100%" }} onChange={event => { void read(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
    {loading && <small role="status">正在读取工作簿…</small>}
    {workbook && <label>选择工作表<select aria-label="工作表" value={sheet} onChange={event => showSheet(workbook, event.target.value)}>{workbook.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select><small> XLSX 需要服务端 Python 3；仅读取缓存值，不执行公式。</small></label>}
    {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
    {preview && <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <strong style={{ overflowWrap: "anywhere" }}>{preview.name} · {preview.result?.rows ?? 0} 行 · {charts.length} 个图表</strong>
      <label>图表标题<input aria-label="图表标题" value={preview.title} onChange={event => updatePreview(preview.name, event.target.value, preview.source)} style={{ width: "100%", boxSizing: "border-box", minWidth: 0 }} /></label>
      <label>原始表格（可编辑，修改后自动更新预览）<textarea aria-label="原始表格" value={preview.source} onChange={event => updatePreview(preview.name, preview.title, event.target.value)} rows={5} style={{ width: "100%", boxSizing: "border-box", minWidth: 0, resize: "vertical" }} /></label>
      {preview.result?.warnings.map(warning => <small key={warning}>{warning}</small>)}
      <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid var(--line-2)", borderRadius: 8 }}>
        {charts.map(chart => <table key={chart.id} style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 12 }}><caption>{chart.heading ?? chart.id} · {chartLabels[chart.chartType] ?? chart.chartType}</caption><thead><tr><th>标签</th><th>数值</th>{chart.data.some(row => row.value2 !== undefined) && <th>第二系列</th>}</tr></thead><tbody>{chart.data.map((row, index) => <tr key={index}><td>{row.label}</td><td>{row.value}</td>{chart.data.some(item => item.value2 !== undefined) && <td>{row.value2 ?? "—"}</td>}</tr>)}</tbody></table>)}
      </div>
      <small>预览的是解析后将写入工程的数据；图表与旁白可继续编辑。{replacesProject ? "创建前会保存当前工程。" : ""}</small>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={button} disabled={!preview.result || !preview.title.trim()} onClick={() => {
          if (!preview.result || !preview.title.trim()) return;
          const project = parseProject({ schemaVersion: 1, id: `table-${crypto.randomUUID()}`, title: preview.title, aspect, knowledgeSources: [{ id: "table-source", kind: "markdown", name: preview.name }], scenes: preview.result.scenes });
          if (onProject(project, preview.source)) setPreview(null);
        }}>创建图表工程</button>
        <button type="button" style={button} onClick={() => setPreview(null)}>取消导入</button>
      </div>
    </div>}
  </div>;
}
