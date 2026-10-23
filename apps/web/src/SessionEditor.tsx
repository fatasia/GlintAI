import { useEffect, useRef, useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { SceneEditor } from "./SceneEditor";
import { downloadJson } from "./editor-model";
import { diffProject, StudioSessionClient, type SessionView } from "./session-client";

const button = { background: "#1c2938", border: "1px solid #3c4e62", color: "#cee1f8", padding: "8px 12px", borderRadius: 8, cursor: "pointer", font: "inherit" };
export function SessionEditor({ project, onChange, onFork, voiceEngine }: {
  project: SceneScriptProject; onChange(project: SceneScriptProject): void; onFork(project: SceneScriptProject): void; voiceEngine: string;
}) {
  const client = useRef<StudioSessionClient | null>(null);
  const callbacks = useRef({ onChange, onFork }); callbacks.current = { onChange, onFork };
  const initial = useRef(project);
  const [view, setView] = useState<SessionView | null>(null);
  const [backupError, setBackupError] = useState("");
  useEffect(() => {
    const next = new StudioSessionClient(initial.current, value => {
      setView(value); callbacks.current.onChange(value.project);
      // The workspace also autosaves, but conflicts need an immediate independent backup.
      if (value.dirty || value.status === "error" || value.status === "conflict") {
        try { localStorage.setItem(`glint.session-draft:${value.project.id}`, JSON.stringify(value.project)); }
        catch { setBackupError("本机备份不可用，请导出本地草稿后再切换工程"); }
      }
    });
    client.current = next; setView(next.state()); void next.connect();
    const poll = setInterval(() => { void next.poll(); }, 1500);
    return () => { next.dispose(); clearInterval(poll); client.current = null; };
  }, []);
  useEffect(() => {
    const current = client.current;
    if (current && canonicalJson(project) !== canonicalJson(current.state().project)) current.update(project);
  }, [project]);
  const current = view?.project ?? project;
  const unsettled = !view || view.status !== "ready" || view.dirty;
  const saveBackup = () => {
    try { localStorage.setItem(`glint.session-backup:${current.id}:${Date.now()}`, JSON.stringify(current)); return true; }
    catch { setBackupError("无法保留本地副本。请先导出草稿，再选择共享版本。"); return false; }
  };
  return <section aria-label="共享工程编辑" style={{ display: "grid", gap: 12, minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <strong>共享工程</strong><code style={{ overflowWrap: "anywhere" }}>{current.id}</code>
      <span role="status">{view?.message ?? "正在连接共享工程"}</span>
      <button type="button" style={button} disabled={view?.status === "saving" || view?.status === "opening"} onClick={() => void client.current?.poll()}>同步其他入口</button>
    </div>
    <div aria-label="Agent 上下文" style={{ fontSize: 13, color: "#b6cbe0", display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span>工程 r{view?.look?.revision ?? "…"}</span><span>目标：{view?.look?.selection.join("、") || "未指定分镜"}</span><span>修改指令发送时固定目标；不随后续选择改变</span>
    </div>
    {(view?.status === "conflict" || view?.status === "error") && <div role="alert" style={{ padding: 14, border: "1px solid #a8824b", borderRadius: 10, display: "grid", gap: 10 }}>
      <strong>{view.status === "conflict" ? "版本不同，草稿仍保留" : "共享保存未确认，草稿仍保留"}</strong>
      <p style={{ margin: 0 }}>可以继续修改本地草稿。共享版本不会被自动覆盖；恢复请求会沿用原事务 ID。</p>
      {view.remote && <details><summary>查看共享版本与本地草稿的不同字段</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto" }}>{diffProject(view.remote, current).operations.map(op => op.path.join(".")).join("\n") || "字段相同"}</pre></details>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {view.status === "error" && <button type="button" style={button} onClick={() => void client.current?.retry()}>恢复原提交</button>}
        <button type="button" style={button} onClick={() => downloadJson(`${current.id}.local-draft.json`, current)}>导出本地草稿</button>
        <button type="button" style={button} onClick={() => { if (saveBackup()) void client.current?.reload(); }}>保留副本并接续共享版本</button>
        <button type="button" style={button} onClick={() => { if (saveBackup()) callbacks.current.onFork({ ...current, id: `${current.id.slice(0, 45)}-branch-${crypto.randomUUID().slice(0, 8)}`, title: `${current.title} · 分支` }); }}>另存为新工程</button>
      </div>
    </div>}
    {backupError && <p role="alert">{backupError}</p>}
    {view?.receipt && <details><summary>最近提交 · {view.receipt.stage === "verified" ? "数据回读通过" : view.receipt.stage === "refused" ? "已拒绝" : "已保存历史修订"} · r{view.receipt.revision ?? view.receipt.baseRevision}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(view.receipt, null, 2)}</pre><small>数据回读只验证持久化工程；不代表画面、声音或最终视频已经检查。</small></details>}
    <SceneEditor project={current} voiceEngine={voiceEngine} onChange={value => client.current?.update(value)}
      history={!unsettled && view ? { undoDepth: view.look?.undoDepth ?? 0, redoDepth: view.look?.redoDepth ?? 0, undo: () => void client.current?.history("undo"), redo: () => void client.current?.history("redo") } : undefined}
      selection={view?.look?.selection} onSelect={handle => void client.current?.select([handle])} />
  </section>;
}
