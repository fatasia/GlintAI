import { useEffect, useRef, useState } from "react";
import { IMAGE_EDIT_PRESETS } from "@glintai/media/presets";
const field = { width: "100%", minWidth: 0, padding: 11, border: "1px solid #35414e", borderRadius: 8, color: "#f2f6fa", background: "#141b24", font: "inherit" };
export function MediaWorkshop() {
  const [type, setType] = useState("image"), [models, setModels] = useState<{id:string;name:string;description?:string;tags?:string[]}[]>([]), [model, setModel] = useState(""), [prompt, setPrompt] = useState(""), [params, setParams] = useState("{}"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [protocol, setProtocol] = useState("skills");
  const openaiImages = protocol === "openai-images";
  const [job, setJob] = useState<{ taskId: string; state?: string; isFinal?: boolean; assetUrl?: string } | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [retry, setRetry] = useState(0), [paused, setPaused] = useState(false);
  const [library, setLibrary] = useState<{ name: string; url: string; bytes: number }[]>([]);
  const [versions, setVersions] = useState<{ file: string; parent: string | null; model: string; prompt: string; cost?: number; at?: string; url: string }[]>([]);
  const [candidate, setCandidate] = useState<string | null>(null);

  const refreshLibrary = async () => {
    try {
      const [libraryResponse, versionsResponse] = await Promise.all([fetch("/api/media/library"), fetch("/api/media/versions")]);
      const libraryData = await libraryResponse.json(), versionsData = await versionsResponse.json();
      if (libraryResponse.ok && Array.isArray(libraryData.assets)) setLibrary(libraryData.assets);
      if (versionsResponse.ok && Array.isArray(versionsData.versions)) setVersions(versionsData.versions);
    } catch { /* Gallery is optional; generation still works. */ }
  };
  useEffect(() => { void refreshLibrary(); }, [job?.isFinal]);

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
    void fetch(`/api/media/models?type=${type}`, { signal: controller.signal }).then(response => response.json()).then(data => {
      if (data.protocol === "openai-images") { setProtocol("openai-images"); if (type !== "image") { setType("image"); return; } }
      else if (data.protocol === "skills") setProtocol("skills");
      setModels(data.models ?? []); setModel(data.models?.[0]?.id ?? "");
    }).catch(() => {});
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
    <label>素材类型<select aria-label="素材类型" disabled={busy || openaiImages || Boolean(recovery || job && !job.isFinal)} style={field} value={type} onChange={event => { setType(event.target.value); setModels([]); setModel(""); setJob(null); setError(""); }}><option value="image">图片 / 图片编辑</option><option value="video" disabled={openaiImages}>短视频{openaiImages ? "（需 skills 协议）" : ""}</option><option value="audio" disabled={openaiImages}>配乐 / 语音{openaiImages ? "（需 skills 协议）" : ""}</option></select></label>
    {openaiImages && <small role="note">当前为 OpenAI Images 协议：只支持图片，同步出图。视频与配乐请到「模型连接设置 → 媒体网关」切换为 skills 协议。</small>}
    <label>媒体模型<select aria-label="媒体模型" style={field} value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {(() => { const selected = models.find(item => item.id === model); if (!selected) return null; return <div aria-label="模型说明" style={{ display: "grid", gap: 4 }}>
      {selected.description && <small>{selected.description}</small>}
      {selected.tags && selected.tags.length > 0 && <small>{selected.tags.map(tag => `#${tag}`).join(" ")}</small>}
    </div>; })()}
    {!models.length && <small>{openaiImages ? "OpenAI Images 协议下没有可用的图片模型。请在网关侧确认 gpt-image 系模型可用，并保存一次设置以刷新模型列表。" : "尚未配置媒体网关，或当前类型没有可用模型。服务端使用 GLINT_MEDIA_BASE_URL 和 GLINT_MEDIA_API_KEY。"}</small>}
    <label>描述<textarea aria-label="素材描述" style={field} rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述主体、风格、构图和要修改的部分" /></label>
    {type === "image" && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="图片编辑预设">
      {Object.entries(IMAGE_EDIT_PRESETS).map(([id, text]) => <button key={id} type="button" style={{ ...field, width: "auto", cursor: "pointer", fontSize: 12 }} onClick={() => setPrompt(text)}>{id}</button>)}
    </div>}
    <details><summary>模型参数与参考素材</summary><p>按模型文档填 JSON。参考图可填网关支持的公网地址；只有点击生成才会发送。</p><textarea aria-label="媒体模型参数" style={field} rows={4} value={params} onChange={event => setParams(event.target.value)} /><small>Suno 纯音乐参数：{"{\"make_instrumental\":\"instrumental\",\"mv\":\"v6-mini\"}"}</small></details>
    <button type="button" disabled={busy || !model || !prompt.trim() || Boolean(recovery || job && !job.isFinal)} onClick={async () => {
      setBusy(true); setError("");
      try {
        const parsed = JSON.parse(params), signature = JSON.stringify([type, model, prompt, parsed]);
        if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
        try { localStorage.setItem("glint.media-task", JSON.stringify({ requestId: request.current.id })); } catch {}
        const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, model, prompt, params: parsed, requestId: request.current.id }), signal: AbortSignal.timeout(openaiImages ? 240_000 : 40_000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        setJob(data);
      } catch (error) { const message = error instanceof Error ? error.message : "生成失败"; setError(openaiImages && /only generates images/i.test(message) ? "当前网关协议只支持图片；视频/配乐请先在「模型连接设置 → 媒体网关」切换为 skills 协议。" : message); if (request.current) { setRecovery(request.current.id); setPaused(true); } }
      finally { setBusy(false); }
    }}>{busy ? "提交中…" : "生成素材（使用网关额度）"}</button>
    {paused && <button type="button" onClick={() => { setPaused(false); setError(""); setRetry(value => value + 1); }}>恢复查询（不重新生成）</button>}
    {recovery && <button type="button" onClick={() => { setRecovery(null); setPaused(false); try { localStorage.removeItem("glint.media-task"); } catch {} }}>停止查询（确认网关状态后再生成）</button>}
    {job?.isFinal && <button type="button" onClick={() => { setJob(null); request.current = null; try { localStorage.removeItem("glint.media-task"); } catch {} }}>新建素材任务</button>}
    <section aria-label="最近素材与版本" style={{ display: "grid", gap: 10, paddingTop: 12, borderTop: "1px solid #2a3442" }}>
      <h3 style={{ margin: 0 }}>最近素材</h3>
      {library.length ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{library.filter(asset => /\.(png|jpg|webp)$/i.test(asset.name)).slice(0, 12).map(asset => (
        <button key={asset.name} type="button" onClick={() => setCandidate(asset.url)} style={{ display: "grid", gap: 4, padding: 6, borderRadius: 8, border: "1px solid #35414e", background: "#141b24", color: "#cee1f8", cursor: "pointer", font: "inherit", fontSize: 12 }}>
          <img src={asset.url} alt={asset.name} width={96} height={54} style={{ objectFit: "cover", borderRadius: 4 }} />
          {asset.name}
        </button>
      ))}</div> : <small>还没有素材。生成或编辑图片后会出现在这里。</small>}
      {candidate && <img src={candidate} alt="当前候选" style={{ maxWidth: "100%", maxHeight: 240, borderRadius: 8, border: "1px solid #35414e" }} />}
      {versions.length > 0 && <div style={{ display: "grid", gap: 6 }}>
        <h4 style={{ margin: 0 }}>编辑版本链</h4>
        {versions.slice(-10).reverse().map(version => (
          <button key={version.file} type="button" onClick={() => setCandidate(version.url)} style={{ textAlign: "left", padding: 8, borderRadius: 8, border: "1px solid #35414e", background: "#141b24", color: "#cee1f8", cursor: "pointer", font: "inherit", fontSize: 12 }}>
            <strong>{version.file}</strong>{version.parent ? ` ← ${version.parent}` : ""}{version.model ? ` · ${version.model}` : ""}{version.cost !== undefined ? ` · ${version.cost} 算力` : ""}
            {version.prompt && <span style={{ display: "block", color: "#91a0b2" }}>{version.prompt.slice(0, 120)}</span>}
          </button>
        ))}
      </div>}
    </section>
    {job && <p role="status">任务 {job.taskId} · {job.state ?? "已提交"}</p>}
    {job?.assetUrl && <><a href={job.assetUrl} download>下载素材</a>{/\.(png|jpg|webp)$/.test(job.assetUrl) ? <img alt="生成的素材" src={job.assetUrl} style={{ width: "100%", maxHeight: 480, objectFit: "contain" }} /> : job.assetUrl.endsWith(".mp4") ? <video controls src={job.assetUrl} style={{ width: "100%" }} /> : <audio controls src={job.assetUrl} />}</>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
