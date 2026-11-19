import { useRef, useState, type ReactNode } from "react";
import { DESIGN_HTML_LIMIT, DESIGN_PAGE_LIMIT, type DesignDocument, type DesignPage } from "./design-artifacts";
export function DesignPageRail({ document: doc, onSelect, onAdd, onDuplicate, onDelete, onReorder, onImport, onError, panel }: { document: DesignDocument; onSelect: (id: string) => void; onAdd: () => void; onDuplicate: () => void; onDelete: () => void; onReorder: (from: number, to: number) => void; onImport: (title: string, html: string) => void; onError: (error: string) => void; panel?: ReactNode }) {
  const dragged = useRef<number | null>(null), file = useRef<HTMLInputElement>(null), request = useRef(0);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const active = doc.pages.findIndex(page => page.id === doc.activePageId);
  async function importFile(input: File | undefined) {
    if (!input) return; const token = ++request.current;
    if (input.size > DESIGN_HTML_LIMIT) { onError("HTML 超过 1 MB，请精简后再导入。"); return; }
    if (!/\.html?$/i.test(input.name)) { onError("请选择 .html 或 .htm 文件；不会导入或执行其他格式。"); return; }
    setBusy(true);
    try { const html = await input.text(); if (token === request.current) onImport(input.name.replace(/\.html?$/i, ""), html); }
    catch { onError("HTML 文件读取失败，请重新选择本地文件。"); }
    finally { if (token === request.current) setBusy(false); }
  }
  return <aside className="design-page-rail" aria-label="设计页面列表">
    <div className="design-panel-head"><strong>{doc.kind === "slides" ? "幻灯片" : "页面"}</strong><span>{doc.pages.length} 页</span></div>
    <div className="design-page-list">{doc.pages.map((page: DesignPage, index) => <div className="design-page-row" key={page.id} draggable onDragStart={event => { dragged.current = index; event.dataTransfer?.setData("text/plain", page.id); }} onDragEnd={() => { dragged.current = null; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged.current !== null) onReorder(dragged.current, index); dragged.current = null; }}>
      <button type="button" aria-label={`选择页面 ${index + 1} ${page.title}`} aria-pressed={page.id === doc.activePageId} onClick={() => { setConfirm(false); onSelect(page.id); }} title={page.title}><span className="design-page-number">{String(index + 1).padStart(2, "0")}</span><span>{page.title}</span></button>
    </div>)}</div>
    <div className="design-page-tools"><button type="button" onClick={onAdd} disabled={doc.pages.length >= DESIGN_PAGE_LIMIT} title={doc.pages.length >= DESIGN_PAGE_LIMIT ? "最多 100 页" : "添加可编辑页面"}>新增页</button><button type="button" onClick={onDuplicate} disabled={doc.pages.length >= DESIGN_PAGE_LIMIT} title={doc.pages.length >= DESIGN_PAGE_LIMIT ? "最多 100 页" : "复制当前页"}>复制页</button>
      <button type="button" disabled={active <= 0} title={active <= 0 ? "已经是第一页" : "上移当前页"} onClick={() => onReorder(active, active - 1)}>上移</button><button type="button" disabled={active >= doc.pages.length - 1} title={active >= doc.pages.length - 1 ? "已经是最后一页" : "下移当前页"} onClick={() => onReorder(active, active + 1)}>下移</button>
      <button type="button" disabled={doc.pages.length < 2} title={doc.pages.length < 2 ? "至少保留一个页面" : "删除需确认，可撤销"} onClick={() => setConfirm(true)}>删除页</button>
      <button type="button" onClick={() => file.current?.click()} disabled={busy} title={busy ? "正在读取本地 HTML" : "作为新页导入，不覆盖当前页面"}>{busy ? "读取中…" : "导入 HTML"}</button>
      <input ref={file} type="file" accept=".html,.htm,text/html" aria-label="导入本地 HTML" hidden onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    {confirm && <div className="design-delete-confirm" role="group" aria-label="确认删除页面"><p>删除当前页？可使用撤销恢复。</p><button type="button" onClick={() => { onDelete(); setConfirm(false); }}>确认删除页</button><button type="button" onClick={() => setConfirm(false)}>取消</button></div>}
    {panel}
    <p className="design-hint">拖动列表调整顺序；也可用上移／下移按钮。导入仅在隔离预览运行，外部网络被限制。</p>
  </aside>;
}
