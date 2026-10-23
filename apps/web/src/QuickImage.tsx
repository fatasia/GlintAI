import { useEffect, useRef, useState } from "react";

const SIZES = [
  { id: "1024x1024", label: "方形 1:1" },
  { id: "1024x1536", label: "竖版 3:4" },
  { id: "1536x1024", label: "横版 4:3" },
] as const;
const LAST_TASK_KEY = "glint.quick-image";
const TERMINAL = new Set(["success", "failed", "cancelled", "canceled"]);

type Model = { id: string; name: string; description?: string };
type Job = { taskId: string; state?: string; isFinal?: boolean; assetUrl?: string };

const field = { boxSizing: "border-box" as const, width: "100%", minWidth: 0, padding: "9px 11px", borderRadius: 8, border: "1px solid #2b2b31", background: "#101013", color: "#e4e4e7", font: "inherit", fontSize: 13 };

/**
 * The image side of the one-box entry. It only submits when the user presses
 * the button, reuses a stable request id for an identical retry, and restores
 * an in-flight task instead of paying twice after a reload.
 */
export function QuickImage({ disabled = false }: { disabled?: boolean }) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState("skills");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<string>(SIZES[0].id);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/media/models?type=image", { signal: controller.signal })
      .then(response => response.json())
      .then(data => {
        if (controller.signal.aborted) return;
        if (data?.protocol === "openai-images" || data?.protocol === "skills") setProtocol(data.protocol);
        const list: Model[] = Array.isArray(data?.models) ? data.models.filter((item: Model) => typeof item?.id === "string") : [];
        setModels(list); setModel(current => current || list[0]?.id || ""); setModelsLoaded(true);
      })
      .catch(() => { setModelsLoaded(true); /* The composer explains the missing gateway below. */ });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_TASK_KEY) ?? "null");
      if (typeof saved?.taskId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.taskId)) setJob({ taskId: saved.taskId });
      else if (typeof saved?.requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.requestId)) setRecovery(saved.requestId);
    } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => {
    if (!recovery) return;
    const controller = new AbortController();
    void fetch(`/api/media/request/${recovery}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error("提交回执未确认，请先查询网关任务，避免重复计费。");
        if (typeof data?.taskId === "string") { setJob({ taskId: data.taskId }); setRecovery(null); setError(""); }
      })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "回执查询失败"); });
    return () => controller.abort();
  }, [recovery, retry]);
  useEffect(() => {
    if (!job || job.isFinal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/media/status/${job.taskId}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "任务查询失败");
        if (controller.signal.aborted) return;
        setJob(data);
        if (!data.isFinal) timer = setTimeout(() => void poll(), 8000);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "任务查询失败");
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.taskId, job?.isFinal, retry]);
  const running = Boolean(job && !job.isFinal && !TERMINAL.has(job.state ?? ""));

  const submit = async () => {
    if (disabled || busy || running) return;
    const text = prompt.trim();
    if (!text) { setError("先描述一下画面。"); return; }
    if (!model) { setError("没有可用的图片模型：请先在「工具与设置 → 模型连接」配置媒体网关。"); return; }
    const params = protocol === "openai-images" ? { size } : {};
    const signature = JSON.stringify(["image", model, text, params]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError(""); setJob(null);
    try {
      localStorage.setItem(LAST_TASK_KEY, JSON.stringify({ requestId: request.current.id }));
    } catch { /* Storage is optional. */ }
    try {
      const response = await fetch("/api/media/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image", model, prompt: text, params, requestId: request.current.id }),
        signal: AbortSignal.timeout(240_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "提交失败");
      if (mounted.current && typeof data?.taskId === "string") { request.current = null; setJob(data); setRecovery(null); }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "生成失败");
        if (request.current) setRecovery(request.current.id);
      }
    } finally { if (mounted.current) setBusy(false); }
  };

  return <section aria-label="生成图片" style={{ display: "grid", minWidth: 0, background: "#151518", borderRadius: 18, boxShadow: "0 30px 80px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.045)", overflow: "hidden" }}>
    <textarea aria-label="图片描述" rows={3} maxLength={4000} value={prompt} disabled={disabled || running} onChange={event => { setPrompt(event.target.value); setError(""); }} placeholder="描述画面：主体、风格、光线和构图。例如「雨夜的老街，暖黄路灯，电影感」。" style={{ boxSizing: "border-box", width: "100%", border: 0, resize: "none", background: "transparent", color: "#f4f4f5", padding: "20px 22px 6px", font: "inherit", fontSize: 16, lineHeight: 1.65 }} />
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 14px 14px" }}>
      <select aria-label="图片模型" value={model} disabled={disabled || running || !models.length} onChange={event => setModel(event.target.value)} style={{ ...field, width: "auto", maxWidth: 220 }}>
        {models.length ? models.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">{modelsLoaded ? "未配置图片模型" : "正在读取图片模型…"}</option>}
      </select>
      {protocol === "openai-images" && <select aria-label="图片尺寸" value={size} disabled={disabled || running} onChange={event => setSize(event.target.value)} style={{ ...field, width: "auto" }}>
        {SIZES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>}
      <span style={{ marginLeft: "auto", color: "#8b8b95", fontSize: 12 }}>{prompt.trim().length} 字</span>
      <button type="button" disabled={disabled || busy || running || !prompt.trim() || !model} onClick={() => void submit()} style={{ border: "1px solid #f4f4f5", borderRadius: 999, padding: "9px 18px", font: "inherit", fontSize: 14, fontWeight: 600, cursor: disabled || busy || running || !prompt.trim() || !model ? "not-allowed" : "pointer", background: "#f4f4f5", color: "#09090b", opacity: disabled || busy || running || !prompt.trim() || !model ? 0.45 : 1 }}>{busy ? "正在提交…" : running ? "正在生成…" : "生成图片（用网关额度）"}</button>
    </div>
    {modelsLoaded && !models.length && <small role="note" style={{ padding: "0 22px 16px", color: "#8b8b95" }}>还没有图片模型。到「工具与设置 → 模型连接」填入媒体网关，保存后即可生成。</small>}
    {job && <p role="status" style={{ margin: 0, padding: "0 22px 12px", color: "#a1a1aa", fontSize: 13 }}>{job.isFinal ? "已完成" : `正在生成 · ${job.state ?? "处理中"}`}</p>}
    {job?.assetUrl && <div style={{ display: "grid", gap: 8, padding: "0 22px 18px" }}>
      <img alt="生成的图片" src={job.assetUrl} style={{ width: "100%", maxHeight: 420, objectFit: "contain", borderRadius: 10, border: "1px solid #2b2b31", background: "#0c0c0e" }} />
      <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13, color: "#a1a1aa" }}><a href={job.assetUrl} download style={{ color: "inherit" }}>下载图片</a><button type="button" onClick={() => { setJob(null); try { localStorage.removeItem(LAST_TASK_KEY); } catch { /* optional */ } }} style={{ border: "1px solid #3f3f46", borderRadius: 999, background: "transparent", color: "#d4d4d8", padding: "5px 11px", font: "inherit", fontSize: 12, cursor: "pointer" }}>再生成一张</button></div>
    </div>}
    {recovery && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 22px 16px" }}>
      <button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }} style={{ border: "1px solid #3f3f46", borderRadius: 999, background: "transparent", color: "#d4d4d8", padding: "6px 12px", font: "inherit", fontSize: 12, cursor: "pointer" }}>再查回执（不重新生成）</button>
      <button type="button" onClick={() => setRecovery(null)} style={{ border: "1px solid #2b2b31", borderRadius: 999, background: "transparent", color: "#8b8b95", padding: "6px 12px", font: "inherit", fontSize: 12, cursor: "pointer" }}>停止查询</button>
    </div>}
    {error && job && !job.isFinal && <button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }} style={{ justifySelf: "start", margin: "0 22px 16px", border: "1px solid #3f3f46", borderRadius: 999, background: "transparent", color: "#d4d4d8", padding: "6px 12px", font: "inherit", fontSize: 12, cursor: "pointer" }}>再查一次任务</button>}
    {error && <p role="alert" style={{ margin: 0, padding: "0 22px 16px", color: "#fca5a5", fontSize: 13, overflowWrap: "anywhere" }}>{error}</p>}
    <details style={{ padding: "0 22px 14px", color: "#8b8b95", fontSize: 12 }}><summary style={{ cursor: "pointer" }}>费用与隐私</summary><p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>只有点击生成才会把描述发给已配置的媒体网关，并按网关价格计费。结果保存在当前服务器。</p></details>
  </section>;
}
