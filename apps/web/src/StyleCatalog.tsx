import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import type { ThemeName } from "@glintai/design-tokens";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { readStyleTrial, removeStyleTrial, saveStyleTrial, type StyleTrialReceipt } from "./style-trial";

type Sample = { id: string; status: string; reason?: string; integrity?: string; recordedAt?: string | null; url?: string };
type Version = { id: string; status: string; capturedAt?: string; themePresent?: boolean; theme?: unknown };
const button = { color: "inherit", background: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}
export async function archiveCurrentStyle(project: SceneScriptProject) {
  return request("/api/style-catalog/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(project) });
}

export default function StyleCatalog({ project, selected, onChange }: { project: SceneScriptProject; selected: ThemeName; onChange(project: SceneScriptProject): void }) {
  const latestProject = useRef(project);
  latestProject.current = project;
  const [samples, setSamples] = useState<Sample[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [error, setError] = useState("");
  const [sampleState, setSampleState] = useState<"loading" | "ready" | "error">("loading");
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [showVideo, setShowVideo] = useState(false);
  const [trial, setTrial] = useState<IdeaJob | null>(null);
  const [trialTheme, setTrialTheme] = useState<ThemeName | null>(null);
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialError, setTrialError] = useState("");
  const [trialRejected, setTrialRejected] = useState(false);
  const trialLock = useRef(false);
  const trialRequest = useRef<StyleTrialReceipt | null>(null);
  const [trialReady, setTrialReady] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const recover = async () => {
      try {
        const receipt = readStyleTrial(project.id);
        if (!receipt) return;
        trialRequest.current = receipt;
        setTrialTheme(receipt.theme);
        const job = parseJob(await jobRequest(`/api/make/request/${receipt.requestId}`, {}, controller.signal));
        if (!controller.signal.aborted) { setTrial(job); setTrialError(""); }
      } catch {
        if (!controller.signal.aborted) setTrialError("试片回执或查询不可用；未发起新作业，请检查浏览器存储及本地服务后恢复查询。");
      } finally { if (!controller.signal.aborted) setTrialReady(true); }
    };
    void recover();
    return () => controller.abort();
  }, [project.id]);
  useEffect(() => {
    if (!trial || terminalJob(trial)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = parseJob(await jobRequest(`/api/make/${trial.id}`, {}, controller.signal));
        if (controller.signal.aborted) return;
        setTrial(next); setTrialError("");
        if (!terminalJob(next)) timer = setTimeout(poll, 1500);
      } catch {
        if (!controller.signal.aborted) setTrialError("查询中断，作业可能仍在运行；请点击恢复查询，不会重复提交。");
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [trial?.id, trial?.status, pollRevision]);
  useEffect(() => {
    let active = true;
    setSampleState("loading"); setHistoryState("loading");
    void request("/api/style-catalog/samples")
      .then(catalog => { if (!Array.isArray(catalog?.entries)) throw new Error("样片目录响应格式无效"); if (active) { setSamples(catalog.entries); setSampleState("ready"); } })
      .catch(() => { if (active) setSampleState("error"); });
    void request(`/api/style-catalog/history?projectId=${encodeURIComponent(project.id)}`)
      .then(history => { if (active) { setVersions([...history.entries].sort((a: Version, b: Version) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""))); setHistoryState("ready"); } })
      .catch(() => { if (active) setHistoryState("error"); });
    return () => { active = false; };
  }, [project.id, revision]);
  useEffect(() => { setShowVideo(false); }, [selected]);
  const sample = samples.find(item => item.id === selected);
  const startTrial = async () => {
    if (!trialReady || (trialError && !trialRejected) || trialLock.current || (trial && !terminalJob(trial))) return;
    trialLock.current = true; setTrialBusy(true); setTrialError(""); setTrialRejected(false);
    const candidate = { ...project, theme: selected };
    try {
      const receipt: StyleTrialReceipt = { version: 1, projectId: project.id, theme: selected, requestId: crypto.randomUUID() };
      saveStyleTrial(receipt);
      trialRequest.current = receipt;
      setTrial(null); setTrialTheme(selected);
      const result = await jobRequest("/api/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: candidate, tts: "mock", music: "off", encoding: "draft", requestId: receipt.requestId }) });
      setTrial(parseJob({ id: result.jobId, status: "queued", log: [] }));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && [400, 413, 503].includes(status) && trialRequest.current) {
        try { removeStyleTrial(project.id, trialRequest.current.requestId); trialRequest.current = null; }
        catch { setTrialError("提交被拒，但无法更新回执；请检查浏览器存储。"); return; }
        setTrialRejected(true);
        setTrialError("试片未提交，请检查工程和本地渲染服务后重试。");
      } else setTrialError(trialRequest.current ? "提交回执未确认；点击恢复查询，不会重复提交。" : "无法保存试片回执，未提交作业；请检查浏览器存储。");
    } finally { trialLock.current = false; setTrialBusy(false); }
  };
  const recoverTrial = async () => {
    if (trialLock.current) return;
    trialLock.current = true; setTrialBusy(true);
    try {
      const receipt = readStyleTrial(project.id);
      if (!receipt) { trialRequest.current = null; setTrialError(""); return; }
      trialRequest.current = receipt; setTrialTheme(receipt.theme);
      setTrial(parseJob(await jobRequest(`/api/make/request/${receipt.requestId}`))); setTrialError("");
    } catch { setTrialError("仍无法查询试片回执；请检查本地服务或浏览器存储后再次查询，不会重复提交。"); }
    finally { trialLock.current = false; setTrialBusy(false); }
  };
  const cancelTrial = async () => {
    if (!trial || trialLock.current) return;
    trialLock.current = true; setTrialBusy(true);
    try { await jobRequest(`/api/make/${trial.id}`, { method: "DELETE" }); setPollRevision(value => value + 1); }
    catch { setTrialError("取消未确认，请恢复查询后重试。"); }
    finally { trialLock.current = false; setTrialBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try { await archiveCurrentStyle(project); setNotice("已保存当前主题版本；工程未修改。"); setRevision(value => value + 1); }
    catch { setError("保存版本失败，工程未修改；请检查存储空间后重试。"); }
    finally { setBusy(false); }
  };
  const restore = async (entry: Version) => {
    if (!window.confirm("恢复会替换当前主题。将先保存当前版本，其他工程内容不变；是否继续？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await archiveCurrentStyle(project);
      const result = await request(`/api/style-catalog/history/${entry.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(project) });
      if (latestProject.current !== project) throw new Error("工程已变化");
      onChange(result.project); setNotice("已恢复主题，恢复前版本已保存；可撤销。"); setRevision(value => value + 1);
    } catch { setError("恢复未完成，工程未修改；请检查版本记录和存储后重试。"); }
    finally { setBusy(false); }
  };
  return <section aria-label="主题样片与版本" style={{ display: "grid", gap: 8, border: "1px solid var(--line-2)", borderRadius: 10, padding: 12, minWidth: 0 }}>
    <strong>历史样片与主题版本</strong>
    <small>历史样片为 15 秒无声草稿，展示旧渲染结果，不代表当前主题或跨机器效果。</small>
    {sampleState === "loading" ? <small role="status">正在读取样片目录…</small> : sampleState === "error" ? <p role="alert">无法读取样片目录，请检查本地服务。 <button type="button" style={button} onClick={() => setRevision(value => value + 1)}>重试</button></p> : sample ? <div>{sample.status === "available" && sample.url ? <>
      <button type="button" style={button} onClick={() => setShowVideo(value => !value)}>{showVideo ? "关闭历史样片" : "播放历史样片"}</button>
      <small style={{ display: "block" }}>文件校验：{sample.integrity === "matched" ? "与历史记录一致" : "历史未记录校验值"}{sample.recordedAt ? ` · ${new Date(sample.recordedAt).toLocaleString()}` : ""}</small>
      {showVideo && <video key={sample.url} aria-label="历史风格样片" controls playsInline preload="metadata" src={applicationUrl(sample.url)} style={{ width: "100%", maxWidth: 560 }} onError={() => setError("样片播放失败，请检查文件后重试。")}>浏览器不支持视频播放。</video>}
    </> : <small>历史样片不可用：{sample.reason ?? "文件校验不符"}。</small>}</div> : <small>所选风格暂无历史样片。</small>}
    <section aria-label="当前工程风格试片" style={{ display: "grid", gap: 8 }}>
      <strong>用所选风格生成真实试片</strong>
      <small>使用当前工程副本、本地草稿渲染、静音配音和无音乐；不修改工程，也不调用付费模型。耗时取决于工程长度。</small>
      <div><button type="button" style={button} disabled={!trialReady || trialBusy || Boolean(trialError && !trialRejected) || Boolean(trial && !terminalJob(trial))} onClick={() => void startTrial()}>{trialBusy ? "处理中…" : trialRejected ? "重新生成试片" : "生成当前工程试片"}</button></div>
      {trial && <><small role="status">试片风格：{trialTheme} · 试片状态：{({ queued: "排队中", running: "渲染中", cancelling: "取消中", done: "已完成", failed: "失败", cancelled: "已取消", recovering: "查询中" } as const)[trial.status]}{trial.error ? ` · ${trial.error}` : ""}</small>
        {!terminalJob(trial) && <div><button type="button" style={button} disabled={trialBusy} onClick={() => void cancelTrial()}>取消试片</button></div>}
        {trial.video && <video aria-label="当前工程试片" controls playsInline preload="metadata" src={applicationUrl(trial.video)} style={{ width: "100%", maxWidth: 560 }} />}</>}
      {trialError && <p role="alert" style={{ margin: 0 }}>{trialError} {!trialRejected && <button type="button" style={button} disabled={trialBusy} onClick={() => trialRequest.current || !trial ? void recoverTrial() : setPollRevision(value => value + 1)}>恢复查询</button>}</p>}
    </section>
    <div><button type="button" style={button} disabled={busy} onClick={() => void save()}>保存当前主题版本</button></div>
    <small>版本只保存主题参数，不冻结字体文件、渲染器或完整工程。</small>
    {historyState === "loading" ? <small role="status">正在读取主题版本…</small> : historyState === "error" ? <p role="alert">无法读取主题版本，请检查本地服务与存储。 <button type="button" style={button} onClick={() => setRevision(value => value + 1)}>重试</button></p> : versions.length === 0 ? <small>暂无保存的主题版本。</small> : <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>{versions.map(entry => <li key={entry.id}>
      {entry.status === "valid" ? <><small>{entry.capturedAt && !Number.isNaN(Date.parse(entry.capturedAt)) ? new Date(entry.capturedAt).toLocaleString() : "未知时间"} · {typeof entry.theme === "string" ? entry.theme : entry.themePresent ? "自定义主题 / 快照" : "未设置主题"}</small> <button type="button" style={button} disabled={busy} onClick={() => void restore(entry)}>恢复此版本</button><details><summary>查看主题参数</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto" }}>{entry.themePresent ? JSON.stringify(entry.theme, null, 2) : "工程未设置主题"}</pre></details></> : <small>损坏或不支持的版本，已保留且不能恢复。</small>}
    </li>)}</ul>}
    {busy && <small role="status">正在处理版本…</small>}{notice && <small role="status">{notice}</small>}{error && <p role="alert" style={{ margin: 0 }}>{error} <button type="button" style={button} onClick={() => setRevision(value => value + 1)}>重试</button></p>}
  </section>;
}
