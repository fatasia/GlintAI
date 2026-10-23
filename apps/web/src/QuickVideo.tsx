import { useEffect, useRef, useState, type CSSProperties } from "react";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { DeliveryCheck } from "./DeliveryCheck";

const button: CSSProperties = { color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid currentColor", background: "transparent", color: "inherit", font: "inherit" };
const stages: Record<string, string> = { queued: "排队中", compose: "正在编排分镜", rehearse: "正在准备配音", render: "正在渲染", done: "已完成", failed: "失败", cancelled: "已取消", stopping: "正在停止", cancelling: "正在停止", recovering: "正在恢复任务" };
const CAPABILITY_URL = "/api/settings/llm";
const CAPABILITY_TIMEOUT_MS = 4_000;
const INTENT_MAX_LENGTH = 80;
const MATERIAL_MIN_LENGTH = 20;
const MATERIAL_MAX_LENGTH = 12_000;
const INTENT_NOTICE = "一句话成片需要配置文本模型；可以先粘贴资料，或到设置里配置模型";
const LAST_JOB_KEY = "glint.quick-video.job";

type Capability = "checking" | "available" | "unavailable";
export type QuickVideoMode = "idea" | "source";
export interface QuickVideoExample { label: string; text: string }
export interface QuickVideoPreset { label: string; text: string; aspect: "16:9" | "9:16" | "1:1"; template?: string; theme?: string; nonce: number }
const DEFAULT_EXAMPLES: QuickVideoExample[] = [
  { label: "一分钟讲清熵", text: "用一杯热咖啡和一块冰，讲清楚熵增到底在说什么。" },
  { label: "咖啡店开业", text: "# 咖啡店开业\n\n- 10 月 1 日开业，主打手冲和早餐\n- 前 50 位到店送一杯手冲\n- 地址：市中心老街 18 号\n\n欢迎来喝第一杯。" },
  { label: "产品更新说明", text: "# 本次更新\n\n## 更快\n编辑一镜不再重算整支视频。\n\n## 更省\n只重渲真正改动的镜头。" },
];

/**
 * Local, deterministic split: a short unformatted sentence is an idea worth
 * expanding; anything structured or long is pasted source that must stay
 * evidence. The distinction is visible before submission.
 */
export function detectQuickVideoMode(text: string): QuickVideoMode {
  if (!text.trim()) return "source";
  const lineBreaks = text.match(/\r?\n/g)?.length ?? 0;
  const structured = /^\s{0,3}#{1,6}\s+\S/m.test(text) || /^\s{0,3}(?:[-*+•]|\d+[.)])\s+\S/m.test(text);
  return text.trim().length < INTENT_MAX_LENGTH && lineBreaks < 2 && !structured ? "idea" : "source";
}

/**
 * One box → one silent draft video. Pasted source keeps the offline heuristic
 * path and never needs a model key. A short idea is only sent as an idea when
 * the server reports a configured text model; otherwise the box explains the
 * missing capability and offers to switch to source mode instead of quietly
 * turning one sentence into slides.
 */
export function QuickVideo({ disabled = false, pollMs = 1500, onEditProject, examples = DEFAULT_EXAMPLES, preset }: { disabled?: boolean; pollMs?: number; onEditProject?(project: unknown): void; examples?: QuickVideoExample[]; preset?: QuickVideoPreset }) {
  const [text, setText] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [presetTemplate, setPresetTemplate] = useState("");
  const [presetTheme, setPresetTheme] = useState("");
  useEffect(() => {
    if (!preset) return;
    setText(preset.text); setAspect(preset.aspect); setPresetTemplate(preset.template ?? ""); setPresetTheme(preset.theme ?? ""); setMaterialOverride(false); setError("");
  }, [preset?.nonce]);
  const [job, setJob] = useState<IdeaJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState("");
  const [capability, setCapability] = useState<Capability>("checking");
  const [materialOverride, setMaterialOverride] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const submitted = useRef(false);
  const submission = useRef<{ signature: string; id: string } | null>(null);
  const detectedMode = detectQuickVideoMode(text);
  const mode: QuickVideoMode = materialOverride ? "source" : detectedMode;
  const ideaReady = mode === "idea" && capability === "available";
  const ideaBlocked = mode === "idea" && capability !== "available";
  const intentNotice = mode === "idea" && capability === "unavailable";
  const running = Boolean(job && !terminalJob(job));

  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  // Reattach to a job that was running when the window closed; keep the last result visible.
  useEffect(() => {
    let restored: string | null = null;
    try { restored = localStorage.getItem(LAST_JOB_KEY); } catch { restored = null; }
    if (!restored || !/^idea-[a-z0-9-]+$/.test(restored)) return;
    const current = new AbortController();
    void jobRequest(`/api/make/${restored}`, {}, current.signal)
      .then(value => { if (!current.signal.aborted && !submitted.current) setJob(parseJob(value)); })
      .catch(() => { try { localStorage.removeItem(LAST_JOB_KEY); } catch { /* storage unavailable */ } });
    return () => current.abort();
  }, []);
  useEffect(() => {
    try {
      if (job) localStorage.setItem(LAST_JOB_KEY, job.id);
    } catch { /* storage unavailable: recovery is best-effort */ }
  }, [job]);
  useEffect(() => {
    const current = new AbortController();
    const timer = setTimeout(() => { setCapability("unavailable"); current.abort(); }, CAPABILITY_TIMEOUT_MS);
    const settle = (next: Capability) => { if (!current.signal.aborted) setCapability(next); };
    void fetch(CAPABILITY_URL, { signal: current.signal })
      .then(async response => {
        if (!response.ok) { settle("unavailable"); return; }
        const value: unknown = await response.json();
        settle(value && typeof value === "object" && (value as { configured?: unknown }).configured === true ? "available" : "unavailable");
      })
      .catch(() => settle("unavailable"))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); current.abort(); };
  }, []);
  useEffect(() => {
    if (!job || terminalJob(job)) return;
    const timer = setTimeout(() => {
      const current = controller.current; if (!current) return;
      void jobRequest(`/api/make/${job.id}`, {}, current.signal)
        .then(value => { if (!current.signal.aborted) setJob(parseJob(value)); })
        .catch((err: unknown) => { if (!current.signal.aborted) setError(err instanceof Error ? err.message : "任务状态读取失败，请重试。"); });
    }, pollMs);
    return () => clearTimeout(timer);
  }, [job, pollMs]);
  const submit = async () => {
    if (disabled || busy || running || ideaBlocked) return;
    const source = text.trim();
    if (!source) { setError("先写一句想法，或粘贴一段资料。"); return; }
    if (mode === "source" && source.length < MATERIAL_MIN_LENGTH) { setError("至少写 20 个字，或粘贴一段资料，我才能编排成分镜。"); return; }
    if (mode === "source" && source.length > MATERIAL_MAX_LENGTH) { setError("资料最多 12000 字，请先精简。"); return; }
    submitted.current = true;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setJob(null);
    const body = mode === "idea"
      ? { idea: source, aspect, tts: "mock", music: "off", encoding: "draft", ...(presetTemplate ? { template: presetTemplate } : {}), ...(presetTheme ? { theme: presetTheme } : {}) }
      : { source, tts: "mock", music: "off", encoding: "draft", aspect, ...(presetTemplate ? { template: presetTemplate } : {}), ...(presetTheme ? { theme: presetTheme } : {}) };
    const signature = JSON.stringify(body);
    if (submission.current?.signature !== signature) submission.current = { signature, id: crypto.randomUUID() };
    const requestId = submission.current.id;
    try {
      const result = await jobRequest("/api/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestId }) }, current.signal);
      if (!current.signal.aborted) { submission.current = null; setJob(parseJob({ id: result.jobId, status: "queued", log: [] })); }
    } catch (err) {
      if (current.signal.aborted) return;
      const status = (err as { status?: number })?.status ?? 0;
      if ([400, 413, 429, 503].includes(status)) {
        submission.current = null;
        setError(err instanceof Error ? err.message : "未能开始生成，请稍后重试。");
        return;
      }
      try {
        const receipt = await jobRequest(`/api/make/request/${requestId}`, {}, current.signal);
        if (!current.signal.aborted && typeof receipt?.jobId === "string") {
          submission.current = null;
          setJob({ ...parseJob({ id: receipt.jobId, status: "queued", log: [] }), status: "recovering", stage: "recovering" });
          return;
        }
      } catch { /* keep the conservative message below */ }
      setError("提交回执未确认。请先恢复查询或查看最近作品，确认没有再重试；直接重复提交会重复计费。");
    } finally { if (!current.signal.aborted) setBusy(false); }
  };
  const cancel = async () => {
    if (!job) return;
    try { await jobRequest(`/api/make/${job.id}`, { method: "DELETE" }, controller.current?.signal); setError("已请求取消；若仍在渲染，请稍候再关闭页面。"); }
    catch { setError("取消未确认，请稍后重试。"); }
  };
  const switchToMaterial = () => { setMaterialOverride(true); setError(""); };
  const editProject = async () => {
    if (!job || loadingProject || !onEditProject) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoadingProject(true); setError("");
    try {
      const result = await jobRequest(`/api/make/${job.id}/project`, {}, current.signal);
      if (current.signal.aborted) return;
      if (!result || typeof result.project !== "object" || result.project === null) throw new Error("empty");
      onEditProject(result.project);
    } catch {
      if (!current.signal.aborted) setError("无法载入这支视频的工程：它可能已被清理，或服务尚未生成工程文件。仍可下载 MP4，或重新生成。");
    } finally { if (!current.signal.aborted) setLoadingProject(false); }
  };
  return <section aria-label="快速成片" style={{ display: "grid", minWidth: 0, background: "#151518", border: "1px solid transparent", borderRadius: 18, boxShadow: "0 30px 80px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.045)", overflow: "hidden" }}>
    <textarea aria-label="快速成片资料" rows={4} style={{ boxSizing: "border-box", width: "100%", minWidth: 0, border: 0, resize: "none", background: "transparent", color: "#f4f4f5", padding: "20px 22px 6px", font: "inherit", fontSize: 17, lineHeight: 1.65 }} maxLength={MATERIAL_MAX_LENGTH} value={text} disabled={disabled || running} placeholder="粘贴一段资料，或写一句你想讲的内容。短句按想法处理，长文按资料处理。" onChange={event => { const next = event.target.value; setText(next); if (detectQuickVideoMode(next) === "source") setMaterialOverride(false); setError(""); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} />
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "8px 14px 14px" }}>
      <span aria-label="当前输入模式" aria-live="polite" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, border: "1px solid #2b2b31", background: "#101013", color: "#a1a1aa", fontSize: 12 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#7c8cff" }} />{mode === "idea" ? "一句想法" : "一段资料"}{mode === "idea" && capability === "checking" ? " · 确认中" : ""}</span>
      <div role="group" aria-label="快速成片画幅" style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 999, border: "1px solid #2b2b31", background: "#101013" }}>
        {(["16:9", "9:16", "1:1"] as const).map(value => <button key={value} type="button" aria-pressed={aspect === value} disabled={disabled || running} onClick={() => setAspect(value)} style={{ border: 0, borderRadius: 999, padding: "4px 10px", font: "inherit", fontSize: 12, cursor: "pointer", background: aspect === value ? "#2a2a31" : "transparent", color: aspect === value ? "#f4f4f5" : "#8b8b95" }}>{value}</button>)}
      </div>
      <span style={{ marginLeft: "auto", color: "#8b8b95", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{text.trim().length} 字</span>
      <button type="button" style={{ border: "1px solid #f4f4f5", borderRadius: 999, padding: "9px 18px", font: "inherit", fontSize: 14, fontWeight: 600, cursor: disabled || running || busy || ideaBlocked ? "not-allowed" : "pointer", background: "#f4f4f5", color: "#09090b", opacity: disabled || running || busy || ideaBlocked ? 0.45 : 1 }} disabled={disabled || running || busy || ideaBlocked} title={intentNotice ? INTENT_NOTICE : undefined} aria-describedby={intentNotice ? "quick-video-intent-notice" : undefined} onClick={() => void submit()}>{busy ? "正在提交…" : "生成草稿（免费）"}</button>
      {running && <button type="button" style={{ ...button, borderRadius: 999, padding: "8px 14px", fontSize: 12 }} onClick={() => void cancel()}>取消</button>}
    </div>
    <div aria-label="输入示例" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "0 22px 14px" }}>
      {examples.map(example => <button key={example.label} type="button" disabled={disabled || running} style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid #2b2b31", borderRadius: 999, background: "transparent", color: "#a1a1aa", padding: "5px 11px", font: "inherit", fontSize: 12, cursor: "pointer" }} onClick={() => { setText(example.text); setMaterialOverride(false); setError(""); }}>{example.label}</button>)}
    </div>
    <details style={{ padding: "0 22px 14px", color: "#8b8b95", fontSize: 12 }}>
      <summary style={{ cursor: "pointer" }}>费用与隐私</summary>
      <p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>资料模式完全离线：不联网、不调用模型、不产生费用。一句话成片只使用服务器已配置的文本模型扩写剧本，成片仍是无声草稿。</p>
    </details>
    <div style={{ display: "grid", gap: 12, padding: mode === "idea" && capability === "checking" ? "0 22px 16px" : "0" }}>
      {mode === "idea" && capability === "checking" && <small style={{ color: "#8b8b95" }}>正在确认一句话成片是否可用…</small>}
      {intentNotice && <div id="quick-video-intent-notice" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #2b2b31", borderRadius: 10, color: "#a1a1aa" }}>
        <p role="status" style={{ margin: 0 }}>{INTENT_NOTICE}</p>
        <button type="button" style={{ ...button, justifySelf: "start", borderRadius: 999, padding: "6px 12px", fontSize: 12 }} onClick={switchToMaterial}>改用资料模式</button>
      </div>}
      {ideaReady && <small style={{ color: "#8b8b95", padding: "0 22px" }}>一句话会先扩写成剧本，再离线渲染无声草稿；不生成付费配音或素材。</small>}
      {presetTemplate && <small role="status" style={{ color: "#8b8b95", padding: "0 22px" }}>已套用：{preset?.label ?? presetTemplate}</small>}
    {job && <p role="status" style={{ margin: 0, color: "#a1a1aa", padding: "0 22px" }}>{stages[job.stage ?? job.status] ?? job.status}{job.status === "failed" ? `：${job.error ?? "请检查资料结构后重试。"}` : ""}</p>}
      {job?.status === "done" && job.video && <div style={{ display: "grid", gap: 10, padding: "0 22px 18px" }}><video aria-label="快速成片结果" src={job.video} controls preload="metadata" style={{ width: "100%", maxHeight: 420, borderRadius: 10 }} /><div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", color: "#a1a1aa", fontSize: 13 }}><a style={{ color: "inherit" }} href={`${job.video}?download=1`} download>下载 MP4</a>
        {onEditProject && <button type="button" aria-label="继续编辑这支视频" style={{ ...button, borderRadius: 999, padding: "6px 12px", fontSize: 12 }} disabled={loadingProject} onClick={() => void editProject()}>{loadingProject ? "正在载入工程…" : "继续编辑这支视频"}</button>}
        <DeliveryCheck jobId={job.id} /></div></div>}
      {error && <p role="alert" style={{ margin: 0, color: "#fca5a5", overflowWrap: "anywhere", padding: "0 22px 16px" }}>{error}</p>}
    </div>
  </section>;
}
