import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { detectQuickVideoMode, type QuickVideoMode } from "./input-intent";
export { detectQuickVideoMode, type QuickVideoMode } from "./input-intent";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { DeliveryCheck } from "./DeliveryCheck";
import "./quick-video.css";

const stages: Record<string, string> = { queued: "排队中", compose: "正在编排分镜", rehearse: "正在准备配音", render: "正在渲染", done: "已完成", failed: "失败", cancelled: "已取消", stopping: "正在停止", cancelling: "正在停止", recovering: "正在恢复任务" };
const CAPABILITY_URL = "/api/settings/llm";
const CAPABILITY_TIMEOUT_MS = 4_000;
const INTENT_MAX_LENGTH = 2_000;
const MATERIAL_MIN_LENGTH = 20;
const MATERIAL_MAX_LENGTH = 12_000;
const INTENT_NOTICE = "创作要求需要文本模型。请到设置里配置；已有完整文案可切换「已有资料」。";
const LAST_JOB_KEY = "glint.quick-video.job";

type Capability = "checking" | "available" | "unavailable";
export interface QuickVideoExample { label: string; text: string }
export interface QuickVideoPreset { label: string; text: string; aspect: "16:9" | "9:16" | "1:1"; template?: string; theme?: string; nonce: number }
const DEFAULT_EXAMPLES: QuickVideoExample[] = [
  { label: "一分钟讲清熵", text: "用一杯热咖啡和一块冰，讲清楚熵增到底在说什么。" },
  { label: "咖啡店开业", text: "# 咖啡店开业\n\n- 10 月 1 日开业，主打手冲和早餐\n- 前 50 位到店送一杯手冲\n- 地址：市中心老街 18 号\n\n欢迎来喝第一杯。" },
  { label: "产品更新说明", text: "# 本次更新\n\n## 更快\n编辑一镜不再重算整支视频。\n\n## 更省\n只重渲真正改动的镜头。" },
];

/** One input and one submit action; detected source stays offline and users
 * can explicitly override its type. Missing models never downgrade an idea
 * to literal text cards. */
export function QuickVideo({ disabled = false, pollMs = 1500, onEditProject, examples = DEFAULT_EXAMPLES, preset, onBusyChange }: { disabled?: boolean; pollMs?: number; onEditProject?(project: unknown): void; examples?: QuickVideoExample[]; preset?: QuickVideoPreset; onBusyChange?(busy: boolean): void }) {
  const [text, setText] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [presetTemplate, setPresetTemplate] = useState("");
  const [presetTheme, setPresetTheme] = useState("");
  useEffect(() => {
    if (!preset) return;
    setText(preset.text); setAspect(preset.aspect); setPresetTemplate(preset.template ?? ""); setPresetTheme(preset.theme ?? ""); setModeOverride(null); setError("");
  }, [preset?.nonce]);
  const [job, setJob] = useState<IdeaJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState("");
  const [capability, setCapability] = useState<Capability>("checking");
  const [modeOverride, setModeOverride] = useState<QuickVideoMode | null>(null);
  const composing = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const submitted = useRef(false);
  const submission = useRef<{ signature: string; id: string } | null>(null);
  const detectedMode = detectQuickVideoMode(text);
  const mode = modeOverride ?? detectedMode;
  const ideaBlocked = mode === "idea" && capability !== "available";
  const intentNotice = mode === "idea" && capability === "unavailable";
  const running = Boolean(job && !terminalJob(job));
  useEffect(() => { onBusyChange?.(busy || running || loadingProject); }, [busy, running, loadingProject, onBusyChange]);

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
    if (disabled || busy || running || composing.current) return;
    const source = text.trim();
    if (!source) { setError("先写一句想法，或粘贴一段资料。"); return; }
    if (mode === "idea" && source.length > INTENT_MAX_LENGTH) { setError("创作要求最多 2000 字，请先精简；若粘贴的是完整文案，可选「已有资料」离线编排。"); return; }
    if (ideaBlocked) return;
    if (mode === "source" && source.length < MATERIAL_MIN_LENGTH) { setError("至少写 20 个字，或粘贴一段资料，我才能编排成分镜。"); return; }
    if (mode === "source" && source.length > MATERIAL_MAX_LENGTH) { setError("资料最多 12000 字，请先精简。"); return; }
    submitted.current = true;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setJob(null);
    const body = mode === "idea"
      ? { idea: source, aspect, tts: "mock", music: "off", encoding: "draft", template: presetTemplate || "auto", ...(presetTheme ? { theme: presetTheme } : {}) }
      : { source, tts: "mock", music: "off", encoding: "draft", aspect, template: presetTemplate || "auto", ...(presetTheme ? { theme: presetTheme } : {}) };
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
  return <section aria-label="快速成片" className="qv">
    <div className="qv-input-type">
      <div role="group" aria-label="输入类型" className="qv-type-toggle">
        {([["idea", "创作要求"], ["source", "已有资料"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} disabled={disabled || busy || running} onClick={() => { setModeOverride(value); setError(""); }}>{label}</button>)}
      </div>
      <span aria-label="当前输入模式" aria-live="polite" className="qv-mode">{modeOverride ? "已手动选择" : "自动识别"}：{mode === "idea" ? "创作要求" : "已有资料"}{mode === "idea" && capability === "checking" ? " · 确认中" : ""}</span>
      {modeOverride && <button type="button" className="qv-auto" disabled={disabled || busy || running} onClick={() => { setModeOverride(null); setError(""); }}>恢复自动</button>}
    </div>
    <div className="qv-input-wrap">
      <textarea aria-label="快速成片资料" aria-describedby="quick-video-hint" className="qv-input" rows={3} maxLength={MATERIAL_MAX_LENGTH} value={text} disabled={disabled || busy || running} placeholder="描述你想做的视频，或粘贴已有文案。支持分行、条列要求。" onChange={event => { setText(event.target.value); setError(""); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void submit(); } }} />
      <div className="qv-input-foot">
        <div role="group" aria-label="快速成片画幅" className="qv-aspect">
          {(["16:9", "9:16", "1:1"] as const).map(value => <button key={value} type="button" aria-pressed={aspect === value} disabled={disabled || busy || running} onClick={() => setAspect(value)}>{value}</button>)}
        </div>
        <span className="qv-count tnum">{text.trim().length} 字</span>
        <button type="button" className="qv-generate" disabled={disabled || running || busy || ideaBlocked} title={disabled ? "当前不可用" : busy || running ? "请等待当前任务完成" : ideaBlocked ? capability === "checking" ? "正在确认文本模型是否可用" : INTENT_NOTICE : undefined} aria-describedby="quick-video-hint" onClick={() => void submit()}>{busy ? "正在提交…" : running ? "正在生成…" : mode === "idea" ? "生成视频草稿" : "生成离线草稿"}</button>
        {running && <button type="button" className="qv-cancel" onClick={() => void cancel()}>取消</button>}
      </div>
    </div>
    <p id="quick-video-hint" className="qv-hint">{mode === "source" ? "已有资料仅离线编排，不调用模型；生成无声草稿。" : intentNotice ? INTENT_NOTICE : capability === "checking" ? "正在确认文本模型是否可用；生成的是无声草稿。" : "按创作要求扩写剧本，文本模型可能产生费用；生成无声草稿。"}</p>
    <div aria-label="输入示例" className="qv-examples">
      <span className="qv-examples-label">试试</span>
      {examples.map(example => <button key={example.label} type="button" disabled={disabled || busy || running} onClick={() => { setText(example.text); setModeOverride(null); setError(""); }}>{example.label}</button>)}
    </div>
    <details className="qv-privacy">
      <summary>费用与隐私</summary>
      <p>只有点击生成才会提交输入。「已有资料」在服务器离线编排，不调用外部模型；「创作要求」会发送至已配置的文本模型，可能产生费用。两种模式都先生成无声草稿。</p>
    </details>
    <div className="qv-status">
      {presetTemplate && <small role="status" className="qv-muted">已套用：{preset?.label ?? presetTemplate}</small>}
      {job && <p role="status" className="qv-job-status">{stages[job.stage ?? job.status] ?? job.status}{job.status === "failed" ? `：${job.error ?? "请检查资料结构后重试。"}` : ""}</p>}
      {job?.status === "done" && job.video && <div className="qv-result">
        <video aria-label="快速成片结果" src={applicationUrl(job.video)} controls preload="metadata" />
        <div className="qv-result-actions">
          <a href={applicationUrl(`${job.video}?download=1`)} download>下载 MP4</a>
          {onEditProject && <button type="button" aria-label="继续编辑这支视频" disabled={loadingProject} onClick={() => void editProject()}>{loadingProject ? "正在载入工程…" : "继续编辑这支视频"}</button>}
          <DeliveryCheck jobId={job.id} />
        </div>
      </div>}
      {error && <p role="alert" className="qv-error">{error}</p>}
    </div>
  </section>;
}
