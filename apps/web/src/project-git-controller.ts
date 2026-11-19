import { useEffect, useRef, useState } from "react";
import { captureGit, gitAvailable, gitSignature, gitTime, projectGitRequest, readGitDiff, readGitHistory, readGitSnapshot, readGitStatus, type GitDiffFile, type GitHistory, type GitOperation, type GitSnapshot, type GitStatus, type ProjectGitProps } from "./project-git-client";

type Review = { snapshot: GitSnapshot; signature: string; label: string };
const workspaceOf = (props: ProjectGitProps) => props.getWorkspace?.() ?? props.workspace;
const signatureOf = (props: ProjectGitProps) => JSON.stringify([gitSignature(props.project, props.documents, workspaceOf(props)), props.getStorageSignature?.() ?? null]);
const capturedSignature = (props: ProjectGitProps, captured: ReturnType<typeof captureOf>) => JSON.stringify([gitSignature(captured.snapshot, captured.documents, captured.workspace), props.getStorageSignature?.() ?? null]);
const captureOf = (props: ProjectGitProps) => {
  const workspace = workspaceOf(props);
  return { snapshot: captureGit(props.project), documents: captureGit(props.documents ?? []), ...(workspace === undefined ? {} : { workspace: captureGit(workspace) }) };
};
const applySnapshot = (props: ProjectGitProps, snapshot: GitSnapshot, copy = false) => {
  const apply = copy ? props.onCopy : props.onApply;
  return snapshot.workspace === undefined ? apply?.(snapshot.project, snapshot.documents) : apply?.(snapshot.project, snapshot.documents, snapshot.workspace);
};
const PAGE_SIZE = 30;
export function useProjectGit(props: ProjectGitProps) {
  const { project, kind, documents } = props;
  const [status, setStatus] = useState<GitStatus | null>(null), [history, setHistory] = useState<GitHistory>({ versions: [], more: false, deletedCount: 0 });
  const [files, setFiles] = useState<GitDiffFile[]>([]), [selected, setSelected] = useState<string | null>(null), [diffMode, setDiffMode] = useState<"current" | "parent">("current");
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [message, setMessage] = useState(""), [includeDeleted, setIncludeDeleted] = useState(false), [review, setReview] = useState<Review | null>(null);
  const [synced, setSynced] = useState("");
  const latest = useRef(props); latest.current = props;
  const epoch = useRef(0), lock = useRef(false);
  let signature = "";
  try { signature = signatureOf(props); } catch { /* The explicit operation reports corrupt storage without crashing the panel. */ }
  const available = gitAvailable();
  const fresh = synced === signature;
  const request = <T,>(operation: GitOperation, payload: Record<string, unknown> = {}) => projectGitRequest<T>(project.id, kind, operation, payload);
  const run = async (label: string, work: (valid: () => boolean) => Promise<void>) => {
    if (lock.current || !available) return;
    lock.current = true; const token = epoch.current;
    const valid = () => token === epoch.current;
    setBusy(label); setError(""); setNotice("");
    try { await work(valid); }
    catch (cause) { if (valid()) setError(`${cause instanceof Error ? cause.message : "操作失败。"} 请核对编辑区和本机恢复状态后重试；已保存的 Git 历史仍保留。`); }
    finally { if (valid()) { lock.current = false; setBusy(""); } }
  };
  const read = async (valid: () => boolean, deleted = includeDeleted) => {
    const nextStatus = readGitStatus(await request("status"));
    const nextHistory = readGitHistory(await request("history", { includeDeleted: deleted, limit: PAGE_SIZE, offset: 0 }));
    if (valid()) { setStatus(nextStatus); setHistory(nextHistory); }
  };
  const open = async (valid: () => boolean) => {
    const captured = captureOf(latest.current), expected = capturedSignature(latest.current, captured);
    await request("open", captured);
    await read(valid);
    const nextFiles = readGitDiff(await request("diff"));
    if (valid()) { setFiles(nextFiles); setDiffMode("current"); setSynced(expected); }
  };
  const refresh = () => run("正在读取本地版本…", open);
  useEffect(() => {
    epoch.current++; lock.current = false;
    setStatus(null); setHistory({ versions: [], more: false, deletedCount: 0 }); setFiles([]); setSelected(null); setReview(null); setMessage(""); setSynced(""); setError(""); setNotice("");
    if (available) void refresh();
    return () => { epoch.current++; lock.current = false; };
  }, [project.id, kind, available]);
  const ensureCurrent = (expected: string) => {
    if (signatureOf(latest.current) !== expected) throw new Error("编辑区在操作期间有新修改，未替换工程。请刷新改动后重试。");
  };
  const inspect = (version?: string) => run("正在读取文件差异…", async valid => {
    if (version) {
      const next = readGitDiff(await request("diff", { version }));
      if (valid()) { setSelected(version); setFiles(next); setDiffMode("parent"); }
    } else await open(valid);
  });
  const commit = () => run("正在保存 Git 版本…", async valid => {
    const captured = captureOf(latest.current), expected = capturedSignature(latest.current, captured);
    const result = await request<{ status?: unknown }>("commit", { message: message.trim() || `保存于 ${gitTime(Date.now())}`, ...captured });
    if (!valid()) return;
    if (result.status) setStatus(readGitStatus(result.status));
    setMessage(""); setSynced(expected);
    await read(valid);
    const nextFiles = readGitDiff(await request("diff"));
    if (valid()) { setFiles(nextFiles); setDiffMode("current"); setNotice("版本已保存到本机 Git。"); }
  });
  const restore = (version: string) => run("正在保存当前工程并读取版本…", async valid => {
    const captured = captureOf(latest.current), expected = capturedSignature(latest.current, captured);
    const capturedStatus = readGitStatus(await request("open", captured));
    if (capturedStatus.changedFiles.length) await request("commit", { message: "恢复前保存", ...captured });
    if (!valid()) return;
    ensureCurrent(expected);
    const snapshot = readGitSnapshot(await request("checkout", { version }), kind, project.id);
    if (!valid()) return;
    await read(valid);
    if (valid()) { setReview({ snapshot, signature: expected, label: version.slice(0, 8) }); setNotice("当前工程已另存为「恢复前保存」。请核对下面的版本摘要，再确认替换编辑区。"); }
  });
  const applyReview = () => {
    if (!review || lock.current) return;
    try {
      ensureCurrent(review.signature);
      if (applySnapshot(latest.current, review.snapshot) === false) throw new Error("编辑器没有接受恢复内容；已保存的 Git 版本仍可找回。");
      setReview(null); setSynced(JSON.stringify([gitSignature(review.snapshot.project, review.snapshot.documents, review.snapshot.workspace ?? workspaceOf(latest.current)), latest.current.getStorageSignature?.() ?? null])); setNotice("版本已恢复到编辑区。"); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复未应用，请重试。"); }
  };
  const cancelReview = () => { setReview(null); setSynced(""); setNotice("已取消替换编辑区；当前内容仍保留。点击刷新改动重新核对 Git 状态。"); };
  const copy = (version: string) => run("正在创建独立工程副本…", async valid => {
    if (!latest.current.onCopy) throw new Error("此编辑器暂不支持接收工程副本。");
    const snapshot = readGitSnapshot(await request("copy", { version }), kind, project.id, true);
    if (valid()) {
      if (applySnapshot(latest.current, snapshot, true) === false) throw new Error("编辑器未接受工程副本，未报告创建成功。");
      setNotice("已创建独立工程副本，原工程与历史仍保留。");
    }
  });
  const discard = (expected: string) => run("正在放弃未保存改动…", async valid => {
    ensureCurrent(expected);
    const snapshot = readGitSnapshot(await request("discard"), kind, project.id);
    if (!valid()) return;
    ensureCurrent(expected);
    if (applySnapshot(latest.current, snapshot) === false) throw new Error("编辑器未接受还原内容，请刷新改动后核对。Git 历史仍保留。");
    setSynced(JSON.stringify([gitSignature(snapshot.project, snapshot.documents, snapshot.workspace ?? workspaceOf(latest.current)), latest.current.getStorageSignature?.() ?? null])); await read(valid);
    if (valid()) { setFiles([]); setDiffMode("current"); setNotice("未保存改动已放弃，已回到当前 Git 版本。"); }
  });
  const hideVersions = (versions: string[], recover = false) => run(recover ? "正在找回版本…" : "正在移入已删除版本…", async valid => {
    await request(recover ? "recoverVersions" : "deleteVersions", { versions });
    await read(valid);
    if (valid()) setNotice(recover ? "版本已找回。" : "版本已移入已删除列表；Git 提交与素材文件未删除，可随时找回。");
  });
  const toggleDeleted = (value: boolean) => run("正在筛选历史版本…", async valid => {
    const result = readGitHistory(await request("history", { includeDeleted: value, limit: PAGE_SIZE, offset: 0 }));
    if (valid()) { setIncludeDeleted(value); setHistory(result); }
  });
  const loadMore = () => run("正在读取更多版本…", async valid => {
    const result = readGitHistory(await request("history", { includeDeleted, limit: PAGE_SIZE, offset: history.versions.length }));
    if (valid()) setHistory(previous => ({ ...result, versions: [...previous.versions, ...result.versions.filter(item => !previous.versions.some(old => old.id === item.id))] }));
  });
  return { available, status, history, files, selected, diffMode, busy, error, notice, message, setMessage, includeDeleted, review, signature, fresh,
    refresh, inspect, commit, restore, applyReview, cancelReview, copy, discard, hideVersions, toggleDeleted, loadMore };
}
