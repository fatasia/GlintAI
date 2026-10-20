import { useEffect, useRef, useState } from "react";
const field = { width: "100%", minWidth: 0, padding: 11, border: "1px solid #35414e", borderRadius: 8, color: "#f2f6fa", background: "#141b24", font: "inherit" };
export function MediaWorkshop() {
  const [type, setType] = useState("image"), [models, setModels] = useState<{id:string;name:string}[]>([]), [model, setModel] = useState(""), [prompt, setPrompt] = useState(""), [params, setParams] = useState("{}"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [job, setJob] = useState<{ taskId: string; state?: string; isFinal?: boolean; assetUrl?: string } | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [retry, setRetry] = useState(0), [paused, setPaused] = useState(false);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem("glint.media-task") ?? "null"); if (typeof saved?.taskId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.taskId)) setJob({ taskId: saved.taskId }); else if (saved?.requestId && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.requestId)) setRecovery(saved.requestId); } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => { if (job) try { localStorage.setItem("glint.media-task", JSON.stringify({ taskId: job.taskId })); } catch { /* Storage is optional. */ } }, [job?.taskId]);
  useEffect(() => {
    if (!recovery) return;
    const controller = new AbortController();
    void fetch(`/api/media/request/${recovery}`, { signal: controller.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error("提交回执未确认，请查询网关任务后再生成。");
      setJob(data); setRecovery(null); setPaused(false); setError("");
    }).catch(error => { if (!controller.signal.aborted) { setPaused(true); setError(error.message); } });
    return () => controller.abort();
  }, [recovery, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/media/models?type=${type}`, { signal: controller.signal }).then(response => response.json()).then(data => { setModels(data.models ?? []); setModel(data.models?.[0]?.id ?? ""); }).catch(() => {});
    return () => controller.abort();
  }, [type]);
  useEffect(() => {
    if (!job || job.isFinal) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/media/status/${job.taskId}`, { signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        setJob(data); if (!data.isFinal) timer = setTimeout(() => void poll(), 10000);
      } catch (error) { if (!controller.signal.aborted) { setPaused(true); setError(error instanceof Error ? error.message : "任务查询失败"); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.taskId, job?.isFinal, retry]);
  return <section style={{ display: "grid", gap: 12, padding: 24 }}>
    <h2 style={{ margin: 0 }}>素材工坊</h2><p>用自然语言生成图片、短视频或配乐。结果保存到当前服务器；模型参数与费用由已配置的媒体网关决定。</p>
    <label>素材类型<select aria-label="素材类型" disabled={busy || Boolean(recovery || job && !job.isFinal)} style={field} value={type} onChange={event => { setType(event.target.value); setModels([]); setModel(""); setJob(null); setError(""); }}><option value="image">图片 / 图片编辑</option><option value="video">短视频</option><option value="audio">配乐 / 语音</option></select></label>
    <label>媒体模型<select aria-label="媒体模型" style={field} value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {!models.length && <small>尚未配置媒体网关，或当前类型没有可用模型。服务端使用 GLINT_MEDIA_BASE_URL 和 GLINT_MEDIA_API_KEY。</small>}
    <label>描述<textarea aria-label="素材描述" style={field} rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述主体、风格、构图和要修改的部分" /></label>
    <details><summary>模型参数与参考素材</summary><p>按模型文档填 JSON。参考图可填网关支持的公网地址；只有点击生成才会发送。</p><textarea aria-label="媒体模型参数" style={field} rows={4} value={params} onChange={event => setParams(event.target.value)} /><small>Suno 纯音乐参数：{"{\"make_instrumental\":\"instrumental\",\"mv\":\"v6-mini\"}"}</small></details>
    <button type="button" disabled={busy || !model || !prompt.trim() || Boolean(recovery || job && !job.isFinal)} onClick={async () => {
      setBusy(true); setError("");
      try {
        const parsed = JSON.parse(params), signature = JSON.stringify([type, model, prompt, parsed]);
        if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
        try { localStorage.setItem("glint.media-task", JSON.stringify({ requestId: request.current.id })); } catch {}
        const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, model, prompt, params: parsed, requestId: request.current.id }), signal: AbortSignal.timeout(40000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        setJob(data);
      } catch (error) { setError(error instanceof Error ? error.message : "生成失败"); if (request.current) { setRecovery(request.current.id); setPaused(true); } }
      finally { setBusy(false); }
    }}>{busy ? "提交中…" : "生成素材（使用网关额度）"}</button>
    {paused && <button type="button" onClick={() => { setPaused(false); setError(""); setRetry(value => value + 1); }}>恢复查询（不重新生成）</button>}
    {recovery && <button type="button" onClick={() => { setRecovery(null); setPaused(false); try { localStorage.removeItem("glint.media-task"); } catch {} }}>停止查询（确认网关状态后再生成）</button>}
    {job?.isFinal && <button type="button" onClick={() => { setJob(null); request.current = null; try { localStorage.removeItem("glint.media-task"); } catch {} }}>新建素材任务</button>}
    {job && <p role="status">任务 {job.taskId} · {job.state ?? "已提交"}</p>}
    {job?.assetUrl && <><a href={job.assetUrl} download>下载素材</a>{/\.(png|jpg|webp)$/.test(job.assetUrl) ? <img alt="生成的素材" src={job.assetUrl} style={{ width: "100%", maxHeight: 480, objectFit: "contain" }} /> : job.assetUrl.endsWith(".mp4") ? <video controls src={job.assetUrl} style={{ width: "100%" }} /> : <audio controls src={job.assetUrl} />}</>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
