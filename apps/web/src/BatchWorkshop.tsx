import { applicationUrl } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { applyTemplate, expandSceneGroups, validateBatchTable, type BatchRow } from "@glintai/composer/batch";
import { VideoPlan } from "@glintai/composer/plan";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { ENCODING_OPTIONS, TTS_ENGINES, ttsCost } from "./RenderSummary";
import "./ConnectionSettings.css";

const STORAGE_KEY = "glint.batch-workshop.v1";
const SAMPLE_TABLE = "id,商品名,卖点,素材\npot-01,手冲壶,细口稳定水流|304不锈钢,";
const TEMPLATE = VideoPlan.parse({
  title: "{{name}} · 上新", hook: "{{卖点1}}，一眼心动", audience: "顾客", platform: "9:16", theme: "mint-clean", totalSeconds: 15, takeaway: "了解 {{name}}",
  scenes: [
    { goal: "开场", narration: "这支 {{name}}，{{卖点1}}。", visual: "开场", seconds: 5, kind: "title" },
    { goal: "卖点", narration: "{{卖点1}}，细节都在。", visual: "细节", seconds: 6, kind: "bullets" },
    { goal: "落版", narration: "了解 {{name}}。", visual: "落版", seconds: 4, kind: "title" },
  ],
});

type EntryStatus = "ready" | "submitting" | "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled" | "unknown";
interface Entry { id: string; name: string; projectText: string; status: EntryStatus; requestId?: string; jobId?: string; error?: string }
interface Workspace { table: string; entries: Entry[] }

const STATUS_TEXT: Record<EntryStatus, string> = { ready: "待渲染", submitting: "正在提交", queued: "排队中", running: "渲染中", cancelling: "取消中", done: "视频已完成", failed: "失败", cancelled: "已取消", unknown: "状态待确认" };
const STATUS_DOT: Record<EntryStatus, string> = { ready: "g-dot", submitting: "g-dot g-dot--warn", queued: "g-dot g-dot--warn", running: "g-dot g-dot--warn", cancelling: "g-dot g-dot--warn", done: "g-dot", failed: "g-dot g-dot--warn", cancelled: "g-dot g-dot--off", unknown: "g-dot g-dot--warn" };

/** Build a real project using only named library assets; no invented filenames. */
export function composeRowProject(row: BatchRow): SceneScriptProject {
  if (!row.assets.length) throw new Error("请至少填写一个素材库文件名");
  const plan = applyTemplate(expandSceneGroups(TEMPLATE, row), row).plan;
  return parseProject({ schemaVersion: 1, id: `batch-${crypto.randomUUID()}`, title: plan.title, aspect: "9:16", theme: "mint-clean", knowledgeSources: [],
    scenes: plan.scenes.map((scene, index) => {
      const name = row.assets[index % row.assets.length]!;
      return { id: `s${index + 1}`, kind: /\.mp4$/i.test(name) ? "video" : "image", src: `assets/${name}`, caption: scene.narration, narration: { text: scene.narration, durationMs: scene.seconds * 1000 } };
    }),
  });
}

function validateProject(text: string, library: Set<string>): SceneScriptProject {
  const project = parseProject(JSON.parse(text));
  if (!project.scenes.length || project.scenes.length > 30 || JSON.stringify(project).length > 100000 || project.music) throw new Error("工程需包含 1–30 个场景，且不含工程音乐");
  for (const scene of project.scenes) {
    if (!scene.narration.text.trim() || scene.narration.audioRef) throw new Error("每个场景需要旁白文本，不能使用外部音频");
    if (scene.kind !== "image" && scene.kind !== "video") throw new Error("批量混剪仅支持素材库图片和视频场景");
    const pattern = scene.kind === "video" ? /^assets\/[a-zA-Z0-9_-]{1,100}\.mp4$/ : /^assets\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/;
    if (!pattern.test(scene.src) || !library.has(scene.src.slice(7))) throw new Error(`素材不存在或格式不支持：${scene.src}`);
  }
  return project;
}

function readWorkspace(): Workspace {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Workspace | null;
    if (!value || typeof value.table !== "string" || !Array.isArray(value.entries)) return { table: SAMPLE_TABLE, entries: [] };
    return { table: value.table, entries: value.entries.filter(item => typeof item.id === "string" && typeof item.name === "string" && typeof item.projectText === "string").map(item => ({ ...item, status: ["submitting", "queued", "running", "cancelling"].includes(item.status) ? "unknown" : item.status })) };
  } catch { return { table: SAMPLE_TABLE, entries: [] }; }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function BatchWorkshop() {
  const initial = useRef<Workspace | null>(null);
  if (!initial.current) initial.current = readWorkspace();
  const [table, setTable] = useState(initial.current.table);
  const [validatedTable, setValidatedTable] = useState(initial.current.table);
  const [entries, setEntries] = useState(initial.current.entries);
  const [library, setLibrary] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tts, setTts] = useState("mock");
  const [voices, setVoices] = useState<string[]>(["mock"]);
  const [encoding, setEncoding] = useState("draft");
  const [confirmedKey, setConfirmedKey] = useState("");
  const entriesRef = useRef(entries); const lock = useRef(false); const mounted = useRef(true);
  const persist = (next: Entry[], nextTable = validatedTable) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ table: nextTable, entries: next }));
    entriesRef.current = next;
    if (mounted.current) setEntries(next);
  };
  const update = (id: string, patch: Partial<Entry>) => { const next = entriesRef.current.map(item => item.id === id ? { ...item, ...patch } : item); persist(next); };
  const refreshLibrary = async () => {
    try {
      const result = await jobRequest("/api/media/library");
      if (!Array.isArray(result.assets)) throw new Error("素材库响应无效");
      const names = result.assets.map((item: { name?: unknown }) => item.name).filter((name: unknown): name is string => typeof name === "string" && /^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4)$/.test(name));
      if (mounted.current) { setLibrary(names); setLibraryError(""); }
      return new Set<string>(names);
    } catch { if (mounted.current) setLibraryError("无法读取素材库，请检查本地服务。"); return null; }
  };
  useEffect(() => {
    mounted.current = true; void refreshLibrary();
    void jobRequest("/api/health").then(value => { if (mounted.current && Array.isArray(value.voices)) setVoices(value.voices); }).catch(() => {});
    return () => { mounted.current = false; };
  }, []);
  const confirmationKey = JSON.stringify([tts, encoding, entries.map(({ id, projectText, status }) => [id, projectText, status])]);
  const cost = ttsCost(tts);
  const validate = async () => {
    if (lock.current) return;
    if (entriesRef.current.some(item => ["unknown", "submitting", "queued", "running", "cancelling"].includes(item.status))) { setNotice("请先恢复并处理未确认的任务。"); return; }
    if (entriesRef.current.length && !window.confirm("重新创建会替换当前工程与下载记录，确定继续？")) return;
    lock.current = true; setBusy(true);
    try {
    const assets = await refreshLibrary(); if (!assets) return;
    const result = validateBatchTable(table);
    const messages = result.issues.map(issue => `第 ${issue.row} 行 ${issue.column}：${issue.message}`);
    const next: Entry[] = [];
    for (const row of result.rows) {
      try {
        if (!row.assets.length) throw new Error("请填写素材库中的文件名");
        for (const asset of row.assets) if (!assets.has(asset)) throw new Error(`素材不存在：${asset}`);
        const project = composeRowProject(row);
        validateProject(JSON.stringify(project), assets);
        next.push({ id: row.id, name: row.name, projectText: JSON.stringify(project, null, 2), status: "ready" });
      } catch (error) { messages.push(`${row.id}：${error instanceof Error ? error.message : "工程无效"}`); }
    }
    try { persist(next, table); setValidatedTable(table); setIssues(messages); setNotice(next.length ? `已创建 ${next.length} 个可编辑工程，尚未渲染。` : "没有可用工程。"); }
    catch { setNotice("本机存储不可用，无法保存任务回执；请启用本机存储后重试。"); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const applyJob = (id: string, job: IdeaJob) => update(id, { jobId: job.id, status: job.status === "recovering" ? "unknown" : job.status, error: job.error });
  const recover = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setNotice("");
    try {
      for (const item of entriesRef.current.filter(entry => ["unknown", "submitting", "queued", "running", "cancelling"].includes(entry.status))) {
        try {
          if (!item.jobId && !item.requestId) throw new Error("缺少任务回执，请检查服务端任务");
          const url = item.jobId ? `/api/make/${item.jobId}` : `/api/make/request/${item.requestId}`;
          applyJob(item.id, parseJob(await jobRequest(url)));
        } catch { update(item.id, { status: "unknown", error: "任务状态未确认，请继续查询；不会自动重复提交。" }); }
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const cancel = async (item: Entry) => {
    if (!item.jobId) return;
    try {
      await jobRequest(`/api/make/${item.jobId}`, { method: "DELETE" });
      update(item.id, { status: "cancelling", error: undefined });
      setNotice("取消请求已提交，请恢复查询或等待任务状态更新。");
    } catch { setNotice("取消请求未确认，请恢复查询任务状态。"); }
  };
  const runBatch = async (retryFailed = false) => {
    if (lock.current || table !== validatedTable || entriesRef.current.some(item => ["unknown", "submitting", "queued", "running", "cancelling"].includes(item.status))) return;
    if (cost.requiresConfirmation && confirmedKey !== confirmationKey) { setNotice("当前配音可能计费，请先确认本批次费用。"); return; }
    lock.current = true; setBusy(true); setNotice("");
    try {
      const assets = await refreshLibrary(); if (!assets) return;
      const targets = entriesRef.current.filter(item => retryFailed ? ["failed", "cancelled"].includes(item.status) : item.status === "ready");
      for (const item of targets) {
        let project: SceneScriptProject;
        try { project = validateProject(item.projectText, assets); }
        catch (error) { update(item.id, { status: "failed", error: error instanceof Error ? error.message : "工程无效" }); continue; }
        const requestId = crypto.randomUUID();
        // The receipt must be durable before the network request is sent.
        try { update(item.id, { status: "submitting", requestId, jobId: undefined, error: undefined }); }
        catch { setNotice("无法保存任务回执，已停止提交。"); return; }
        let job: IdeaJob;
        try {
          const value = await jobRequest("/api/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, requestId, aspect: project.aspect, tts, encoding, music: "off" }) });
          job = parseJob({ id: value.jobId, status: "queued", log: [] }); applyJob(item.id, job);
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 400 || status === 413 || status === 503) { update(item.id, { status: "failed", error: error instanceof Error ? error.message : "提交失败" }); continue; }
          update(item.id, { status: "unknown", error: "任务提交状态未确认，请先恢复查询。" }); setNotice("连接中断，已暂停余下任务。"); return;
        }
        try {
          let current = job;
          while (!terminalJob(current)) {
            await wait(1500);
            if (!mounted.current) return;
            current = parseJob(await jobRequest(`/api/make/${job.id}`));
            applyJob(item.id, current);
          }
        } catch {
          update(item.id, { status: "unknown", error: "任务状态未确认，请先恢复查询。" }); setNotice("连接中断，已暂停余下任务。"); return;
        }
      }
    } catch { if (mounted.current) setNotice("本机存储不可用，任务已暂停；请恢复查询。"); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const unknown = entries.some(item => ["unknown", "submitting", "queued", "running", "cancelling"].includes(item.status));
  const ready = entries.filter(item => item.status === "ready").length;
  const failed = entries.filter(item => ["failed", "cancelled"].includes(item.status)).length;
  return <div className="tool-page tool-span" role="region" aria-label="批量混剪">
    <header className="tool-page-head">
      <span className="g-label">自动化 · 批量</span>
      <h2 className="g-title" style={{ margin: 0 }}>批量混剪</h2>
      <p className="g-sub">每行一个工程，素材用 | 分隔；出片在服务端串行执行。</p>
    </header>

    <div className="tool-block" role="group" aria-label="批次设置">
      <div className="tool-block-head">
        <h3>批次设置</h3>
        <span className="g-label g-num">{entries.length} 个工程</span>
      </div>
      <div className="tool-grid-2">
        <label className="g-form-row"><span>配音</span><select className="g-field tool-select" aria-label="批量配音" value={tts} disabled={busy || unknown} onChange={event => setTts(event.target.value)}>{TTS_ENGINES.filter(option => voices.includes(option.id)).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label className="g-form-row"><span>画质</span><select className="g-field tool-select" aria-label="批量画质" value={encoding} disabled={busy || unknown} onChange={event => setEncoding(event.target.value)}>{ENCODING_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      </div>
      <p className="tool-meta">{cost.label} · {cost.detail} 批量出片不调用 LLM 网关。</p>
      {cost.requiresConfirmation && <label className="tool-check"><input type="checkbox" disabled={busy || unknown} checked={confirmedKey === confirmationKey} onChange={event => setConfirmedKey(event.target.checked ? confirmationKey : "")} /> 我确认本批次配音可能产生费用</label>}
    </div>

    <div className="tool-block" role="group" aria-label="表格与校验">
      <div className="tool-block-head">
        <h3>表格</h3>
        <span className="g-label">{table === validatedTable ? "已校验" : "待重新校验"}</span>
      </div>
      <label className="g-form-row"><span>商品表格</span><textarea className="g-field tool-table" aria-label="商品表格" value={table} disabled={busy || unknown} onChange={event => setTable(event.target.value)} spellCheck={false} /></label>

      <div className="tool-actions">
        <button type="button" className="g-btn g-btn--primary" disabled={busy || unknown || table !== validatedTable || !ready} onClick={() => void runBatch()}>{busy ? "处理中…" : `渲染待处理（${ready}）`}</button>
        <button type="button" className="g-btn" disabled={busy || unknown} onClick={() => void validate()}>校验并创建工程</button>
        {failed > 0 && <button type="button" className="g-btn" disabled={busy || unknown || table !== validatedTable} onClick={() => void runBatch(true)}>重试失败行（{failed}）</button>}
        {unknown && <button type="button" className="g-btn" disabled={busy} onClick={() => void recover()}>恢复任务查询</button>}
        <button type="button" className="g-btn g-btn--quiet" disabled={busy} onClick={() => void refreshLibrary()}>刷新素材库</button>
      </div>

      {libraryError || !library.length ? <p className="tool-note">{libraryError || "素材库暂无可用图片或 MP4，请先上传素材。"}</p>
        : <details className="tool-details"><summary>查看可用素材（{library.length}）</summary><p className="tool-note" style={{ paddingTop: 6 }}>{library.join("、")}</p></details>}
      {notice && <p role="status" className="tool-meta">{notice}</p>}
      {table !== validatedTable && <p className="tool-note">表格已修改，请重新校验并创建工程。</p>}
      {issues.length > 0 && <ul aria-label="表格问题" className="tool-issues">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    </div>

    <div className="tool-block" role="group" aria-label="工程清单">
      <div className="tool-block-head">
        <h3>工程</h3>
        <span className="g-label g-num">{entries.length}</span>
      </div>
      {entries.map(item => <section key={item.id} className="tool-list-row">
        <div className="tool-row-head">
          <span className="tool-row-name">{item.name}（{item.id}）</span>
          <span className="tool-status"><span className={STATUS_DOT[item.status]} aria-hidden="true" />{STATUS_TEXT[item.status]}</span>
        </div>
        {item.error && <p role="alert" className="tool-alert">{item.error}</p>}
        <details className="tool-details">
          <summary>编辑 SceneScript 工程</summary>
          <textarea className="g-field tool-table tool-editor" aria-label={`工程 ${item.id}`} style={{ marginTop: 8 }} disabled={busy || unknown} value={item.projectText} onChange={event => { try { update(item.id, { projectText: event.target.value, status: "ready", requestId: undefined, jobId: undefined, error: undefined }); } catch { setNotice("工程保存失败，请检查本机存储。"); } }} spellCheck={false} />
        </details>
        {Boolean(item.jobId) && (item.status === "done" || ["queued", "running"].includes(item.status)) && <div className="tool-row-action">
          {item.status === "done" && item.jobId && <a className="g-btn g-btn--sm" href={applicationUrl(`/api/video/${item.jobId}?download=1`)} download>下载 MP4</a>}
          {item.jobId && ["queued", "running"].includes(item.status) && <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => void cancel(item)}>取消任务</button>}
        </div>}
      </section>)}
    </div>
  </div>;
}
