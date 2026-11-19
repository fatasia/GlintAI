import { useEffect, useRef, useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { SceneEditor } from "./SceneEditor";
import { downloadJson } from "./editor-model";
import { diffProject, StudioSessionClient, type SessionView } from "./session-client";

const button = { background: "var(--ink-2)", border: "1px solid var(--line-2)", color: "#f5f3f7", padding: "8px 12px", borderRadius: 8, cursor: "pointer", font: "inherit" };
export function SessionEditor({ project, onChange, onFork, onGitAccepted, onOpenTimeline, voiceEngine }: {
  project: SceneScriptProject; onChange(project: SceneScriptProject): void; onFork(project: SceneScriptProject): void; onGitAccepted?(project: SceneScriptProject): void; voiceEngine: string; onOpenTimeline?(project:SceneScriptProject):void;
}) {
  const client = useRef<StudioSessionClient | null>(null);
  const callbacks = useRef({ onChange, onFork }); callbacks.current = { onChange, onFork };
  const initial = useRef(project);
  const [view, setView] = useState<SessionView | null>(null);
  const [backupError, setBackupError] = useState("");
  const [reloading, setReloading] = useState(false);
  const reloadActive = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
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
    return () => { live.current = false; next.dispose(); clearInterval(poll); client.current = null; };
  }, []);
  useEffect(() => {
    const current = client.current;
    if (current && canonicalJson(project) !== canonicalJson(current.state().project)) current.update(project);
  }, [project]);
  const current = view?.project ?? project;
  const unsettled = !view || view.status !== "ready" || view.dirty;
  const frozen = current.frozen === true;
  const saveBackup = () => {
    try { localStorage.setItem(`glint.session-backup:${current.id}:${Date.now()}-${crypto.randomUUID()}`, JSON.stringify(current)); setBackupError(""); return true; }
    catch { setBackupError("无法保留本地副本。请先导出草稿，再选择共享版本。"); return false; }
  };
  const resumeShared = async () => {
    if (reloadActive.current || !saveBackup()) return;
    reloadActive.current = true; setReloading(true);
    try { await client.current?.reload(); }
    finally { reloadActive.current = false; if (live.current) setReloading(false); }
  };
  const forkDraft = (needsReview: boolean) => {
    if (!saveBackup()) return;
    const assets = current.assets?.map(asset => {
      if ((asset.kind !== "character" && asset.kind !== "product") || !asset.approval) return asset;
      const { approval: _, ...draft } = asset; return draft;
    });
    callbacks.current.onFork({ ...current, id: `${current.id.slice(0, 45)}-branch-${crypto.randomUUID().slice(0, 8)}`, title: `${current.title} · ${needsReview ? "待重新批准" : "分支"}`, frozen: false, ...(assets ? { assets } : {}) });
  };
  return <section aria-label="共享工程编辑" className="session-editor">
    <div className="session-status"><span role="status" title={view?.message}>{view?.message ?? "正在连接共享工程"}</span><details className="session-details"><summary>同步与版本</summary><div>
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <strong>共享工程</strong><code style={{ overflowWrap: "anywhere" }}>{current.id}</code>
      <button type="button" style={button} disabled={view?.status === "saving" || view?.status === "opening"} onClick={() => void client.current?.poll()}>同步其他入口</button>
      <button type="button" style={button} aria-label={frozen ? "解冻工程" : "冻结工程"} disabled={unsettled || view?.status === "saving"} onClick={() => void client.current?.setFrozen(!frozen)}>{frozen ? "解冻（所有者）" : "批准冻结"}</button>
    </div>
    <div aria-label="Agent 上下文" style={{ fontSize: 13, color: "#a09aae", display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span>工程 r{view?.look?.revision ?? "…"}</span><span>目标：{view?.look?.selection.join("、") || "未指定分镜"}</span><span>修改指令发送时固定目标；不随后续选择改变</span>
      <span role="status" aria-label="批准冻结状态">{frozen ? "已批准冻结：其他入口的修改将被 409 拒绝，仅所有者可解冻" : "未冻结"}</span>
    </div></div></details></div>
    {(view?.status === "conflict" || view?.status === "error") && <div role="alert" style={{ padding: 14, border: "1px solid #a8824b", borderRadius: 10, display: "grid", gap: 10 }}>
      <strong>{view.untrustedImport ? "旧批准需要重新审阅" : view.status === "conflict" ? "版本不同，草稿仍保留" : "共享保存未确认，草稿仍保留"}</strong>
      <p style={{ margin: 0 }}>{view.untrustedImport ? "原工程不会被自动修改；若本机副本无法保存，请先导出本地草稿。" : "可以继续修改本地草稿。共享版本不会被自动覆盖；恢复请求会沿用原事务 ID。接续成功后，可在高级编辑的「本机冲突备份 · 恢复或导出」找回备份。"}</p>
      {view.remote && <details><summary>查看共享版本与本地草稿的不同字段</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto" }}>{diffProject(view.remote, current).operations.map(op => op.path.join(".")).join("\n") || "字段相同"}</pre></details>}
      {view.untrustedImport && <p style={{ margin: 0 }}>新副本会清除角色和商品的批准及工程冻结状态，保留素材、镜头引用和原工程。打开分镜的「生成」→「角色/商品资产与批准」，选择草稿和素材库图片、保存后逐项重新批准；图片缺失时请先导入素材库。</p>}
      {!view.untrustedImport && <p style={{ margin: 0 }}>另存为新工程会清除角色和商品的批准及冻结状态，需重新审阅批准；原草稿会先备份。</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {view.untrustedImport && <button type="button" style={button} onClick={() => forkDraft(true)}>保留原件并创建待重新批准副本</button>}
        {!view.untrustedImport && view.status === "error" && <button type="button" style={button} onClick={() => void client.current?.retry()}>恢复原提交</button>}
        <button type="button" style={button} onClick={() => downloadJson(`${current.id}.local-draft.json`, current)}>导出本地草稿</button>
        {!view.untrustedImport && <button type="button" style={button} disabled={reloading} onClick={() => void resumeShared()}>{reloading ? "正在读取共享版本…" : "保留副本并接续共享版本"}</button>}
        {!view.untrustedImport && <button type="button" style={button} onClick={() => forkDraft(false)}>另存为新工程</button>}
      </div>
    </div>}
    {backupError && <p role="alert">{backupError}</p>}
    {view?.receipt && <details><summary>最近提交 · {view.receipt.stage === "verified" ? "数据回读通过" : view.receipt.stage === "refused" ? "已拒绝" : "已保存历史修订"} · r{view.receipt.revision ?? view.receipt.baseRevision}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(view.receipt, null, 2)}</pre><small>数据回读只验证持久化工程；不代表画面、声音或最终视频已经检查。</small></details>}
    <div aria-label="工程编辑区" aria-disabled={frozen} style={frozen ? { pointerEvents: "none", opacity: 0.55 } : undefined}>
      <SceneEditor project={current} onOpenTimeline={onOpenTimeline} onFork={value => callbacks.current.onFork(value)} onGitAccepted={onGitAccepted} voiceEngine={voiceEngine} canApproveCharacter={!unsettled} onApproveCharacter={id => client.current?.approveCharacter(id) ?? Promise.resolve(false)} canApproveProduct={!unsettled} onApproveProduct={id => client.current?.approveProduct(id) ?? Promise.resolve(false)} onAdoptReferenceCandidate={(taskId, mode) => client.current?.adoptReferenceCandidate(taskId, mode) ?? Promise.resolve(false)} onChange={(value, source) => client.current?.update(value, source === "product-agent" ? { actor: "product-agent", intent: "AI 助手修改分镜" } : undefined)}
        history={{ undoDepth: !unsettled && !frozen ? view?.look?.undoDepth ?? 0 : 0, redoDepth: !unsettled && !frozen ? view?.look?.redoDepth ?? 0 : 0, undo: () => void client.current?.history("undo"), redo: () => void client.current?.history("redo") }}
        selection={view?.look?.selection} onSelect={handle => void client.current?.select([handle])} />
    </div>
  </section>;
}
