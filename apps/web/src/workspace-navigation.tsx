import { useEffect, useRef, type ReactNode } from "react";

export type StudioView = "home" | "plan" | "templates" | "workspace";
export type WorkspaceTool = "history" | "imports" | "reference" | "create" | "export";
export const WORKSPACE_TOOLS: ReadonlyArray<{ id: WorkspaceTool; label: string }> = [
  { id: "history", label: "历史版本" },
  { id: "imports", label: "工程与备份" },
  { id: "reference", label: "参考片" },
  { id: "create", label: "创作参数" },
  { id: "export", label: "配音与导出" },
];

export function WorkspaceToolbar({ title, hasProject, onBack, onPlan, tool, onTool, onSave, disabled, status }: {
  title: string; hasProject: boolean; onBack(): void; onPlan(): void;
  tool: WorkspaceTool | null; onTool(tool: WorkspaceTool): void;
  onSave?(): void; disabled?: boolean; status?: string;
}) {
  return <header className="workspace-toolbar" aria-label="工程导航">
    <button className="home-secondary" onClick={onBack}>返回作品</button>
    <strong className="workspace-title" title={title}>{title}</strong>
    {status && <span className="workspace-save-status" role="status">{status}</span>}
    <nav aria-label="工程操作">
      {onSave && <button className="home-secondary" disabled={disabled || !hasProject} onClick={onSave}>保存项目</button>}
      <details className="workspace-more"><summary className="home-secondary">更多</summary><div>
        <button className="home-secondary" onClick={event => { event.currentTarget.closest("details")!.open = false; onPlan(); }}>方案</button>
        <button className="home-secondary" onClick={event => { event.currentTarget.closest("details")!.open = false; onTool("history"); }}>历史版本</button>
        <button className="home-secondary" onClick={event => { event.currentTarget.closest("details")!.open = false; onTool("imports"); }}>工程与备份</button>
        <button className="home-secondary" onClick={event => { event.currentTarget.closest("details")!.open = false; onTool("reference"); }}>参考片</button>
        <button className="home-secondary" onClick={event => { event.currentTarget.closest("details")!.open = false; onTool("create"); }}>更多创作选项</button>
      </div></details>
      <button className="home-secondary workspace-export" aria-expanded={tool === "export"} aria-controls="workspace-tools" onClick={() => onTool("export")}>{hasProject ? "导出视频" : "导出与任务"}</button>
    </nav>
  </header>;
}

export function WorkspaceTools({ tool, onClose, children }: {
  tool: WorkspaceTool | null; onTool(tool: WorkspaceTool): void; onClose(): void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = tool !== null;
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); };
  }, [open]);
  return <div className="workspace-tools-layer" hidden={!open}>
    <button className="workspace-tools-backdrop" aria-label="关闭创作选项" tabIndex={-1} onClick={onClose} />
    <div id="workspace-tools" className="workspace-tools" ref={panel} role="dialog" aria-modal="true" aria-label={WORKSPACE_TOOLS.find(item => item.id === tool)?.label || "创作选项"} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(node => !node.closest("[hidden]") && node.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="workspace-tools-heading"><h2>{WORKSPACE_TOOLS.find(item => item.id === tool)?.label}</h2><button className="home-secondary" onClick={onClose}>关闭</button></header>
      <div className="workspace-tools-content">{children}</div>
    </div>
  </div>;
}
