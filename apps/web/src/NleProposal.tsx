import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { canonicalJson, type EditOperation } from "@glintai/session";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { diffNleProjects } from "./nle-diff";
import { validateNleAiProposal } from "./nle-ai-proposal";

const button: CSSProperties = { border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--ink-2)", color: "var(--paper-dim)", padding: "7px 11px", font: "inherit", fontSize: 12, cursor: "pointer" };
type Change = { path: string; before: unknown; after: unknown; kind: string };
type Proposal = { next: NleProject; base: string; changes: Change[] };

/** Operations address replay indexes, so capture each old value before applying it. */
export function describeProposal(before: NleProject, after: NleProject): Change[] {
  const operations = diffNleProjects(before, after), replay: any = structuredClone(before);
  for (const [index, track] of before.tracks.entries()) if (track.locked && canonicalJson(track) !== canonicalJson(after.tracks[index])) throw new Error(`轨道「${track.name}」已锁定，提案不能修改或移动它。`);
  return operations.map((op: EditOperation) => {
    let parent: any = replay; for (const segment of op.path.slice(0, -1)) parent = parent[segment];
    const key = op.path.at(-1)!;
    if (op.kind === "insert") {
      const array = parent[key] as unknown[]; array.splice(op.index, 0, structuredClone(op.value));
      return { kind: "新增", path: [...op.path, String(op.index)].join(" / "), before: undefined, after: op.value };
    }
    const old = structuredClone(parent[key]);
    if (op.kind === "delete") { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; return { kind: "删除", path: op.path.join(" / "), before: old, after: undefined }; }
    if (op.kind !== "set") throw new Error("不支持的提案操作。");
    parent[key] = structuredClone(op.value); return { kind: "修改", path: op.path.join(" / "), before: old, after: op.value };
  });
}
const display = (value: unknown) => value === undefined ? "（无）" : typeof value === "string" ? value : JSON.stringify(value);

export function NleProposal({ project, onApply }: { project: NleProject; onApply(next: NleProject): boolean }) {
  const [proposal, setProposal] = useState<Proposal | null>(null), [error, setError] = useState("");
  const [instruction, setInstruction] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), latest = useRef(project), sequence = useRef(0); latest.current = project;
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { sequence.current++; active.current?.abort(); }, []);
  const projectBasis = canonicalJson(project);
  useEffect(() => { setConfirmed(false); }, [instruction, projectBasis]);
  const stale = Boolean(proposal && projectBasis !== proposal.base);
  const read = async (file?: File) => {
    active.current?.abort(); active.current = null; setBusy(false);
    const id = ++sequence.current, snapshot = structuredClone(latest.current); setProposal(null); setError("");
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("提案文件超过 1 MB。");
      const next = parseNleProject(JSON.parse(await file.text()));
      const changes = describeProposal(snapshot, next);
      if (!changes.length) throw new Error("提案与当前工程没有差异。");
      if (sequence.current === id) setProposal({ next, base: canonicalJson(snapshot), changes });
    } catch (cause) { if (sequence.current === id) setError(cause instanceof Error ? cause.message : "提案无法解析。"); }
  };
  const generate = async () => {
    if (active.current || !confirmed || !instruction.trim()) return;
    const id = ++sequence.current, snapshot = structuredClone(latest.current), controller = new AbortController();
    active.current = controller; setBusy(true); setConfirmed(false); setError(""); setProposal(null);
    try {
      const response = await fetch("/api/nle/text-proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: snapshot, instruction }), signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 503 ? "请先配置文本模型。" : "文字提案未生成，请检查模型连接。");
      const next = validateNleAiProposal(snapshot, parseNleProject((await response.json()).project)), changes = describeProposal(snapshot, next);
      if (!changes.length) throw new Error("提案与当前工程没有差异。");
      if (sequence.current === id) setProposal({ next, base: canonicalJson(snapshot), changes });
    } catch (cause) { if (sequence.current === id && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "文字提案无法生成。"); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  return <div style={{ minWidth: 0 }}>
    <button type="button" style={button} onClick={() => fileRef.current?.click()}>预览修改提案</button>
    <input ref={fileRef} type="file" aria-label="选择 NLE 修改提案" accept=".json,application/json" hidden onChange={event => { void read(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
    <details><summary>AI 文字提案</summary>
      <label>修改要求<input aria-label="时间线文字修改要求" maxLength={1000} value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />将未锁定文字、样式及对应轨道片段时间、工程总时长发送给文本模型，可能产生费用</label>
      <button type="button" style={button} disabled={busy || !confirmed || !instruction.trim()} onClick={() => void generate()}>生成文字提案</button>
      {busy && <button type="button" style={button} onClick={() => { sequence.current++; active.current?.abort(); active.current = null; setBusy(false); }}>取消生成</button>}
      <small>只修改已有文字片段的文字、样式、起点和时长；不改素材或锁定轨道，不增加同轨重叠或超出原时间轴。取消只停止等待，服务商可能仍计费。</small>
    </details>
    {error && <p role="alert">{error}</p>}
    {proposal && createPortal(<section aria-label="修改差异预览" style={{ position: "fixed", zIndex: 100, right: 16, top: 70, width: "min(560px, calc(100vw - 32px))", boxSizing: "border-box", maxHeight: "75vh", overflow: "auto", padding: 16, background: "var(--ink-1)", color: "var(--paper)", border: "1px solid var(--line-2)", borderRadius: 12, boxShadow: "0 12px 40px #0008" }}>
      <strong>修改差异 · {proposal.changes.length} 项</strong>
      <p>按执行顺序展示字段变化；新增或删除的对象以 JSON 显示。</p>
      <ol style={{ display: "grid", gap: 12, paddingLeft: 22 }}>{proposal.changes.map((change, index) => <li key={index} style={{ overflowWrap: "anywhere" }}>
        <strong>{change.kind} · {change.path}</strong><div>原值：{display(change.before)}</div><div>新值：{display(change.after)}</div>
      </li>)}</ol>
      {stale && <p role="alert">工程已变化，提案已过期；请重新生成或选择提案。</p>}
      <div style={{ display: "flex", gap: 8 }}><button type="button" style={button} disabled={stale} onClick={() => {
        if (canonicalJson(latest.current) !== proposal.base) { setError("工程已变化，提案未应用。"); return; }
        if (onApply(proposal.next)) setProposal(null);
      }}>应用修改</button><button type="button" style={button} onClick={() => setProposal(null)}>取消</button></div>
    </section>, document.body)}
  </div>;
}
