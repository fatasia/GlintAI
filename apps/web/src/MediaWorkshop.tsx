import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { IMAGE_EDIT_PRESETS } from "@glintai/media/presets";
import { LocalImageTools } from "./LocalImageTools";
import { GatewayBackgroundEdit } from "./GatewayBackgroundEdit";
import { LocalUpscale } from "./LocalUpscale";
import "./ConnectionSettings.css";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import type { VideoSelection } from "./media-work-start";
const MediaExecutionPanel = lazy(() => import("./MediaExecutionPanel").then(module => ({ default: module.MediaExecutionPanel })));
const ComfyWorkflowPanel = lazy(() => import("./ComfyWorkflowPanel").then(module => ({ default: module.ComfyWorkflowPanel })));
const TYPE_LABEL: Record<string, string> = { image: "图片", video: "视频", audio: "音频" };
interface MediaWorkshopProps { initialType?: "image" | "video"; initialPrompt?: string; useVideoLabel?: string; taskStorageKey?: string; disabled?: boolean; onUseVideo?(asset: VideoSelection): Promise<void>; onBusyChange?(busy: boolean): void }
export function MediaWorkshop(props: MediaWorkshopProps) {
  return <MediaWorkshopSession key={props.taskStorageKey ?? "glint.media-task"} {...props} />;
}
function MediaWorkshopSession({ initialType = "image", initialPrompt = "", useVideoLabel = t("creation.useVideo"), taskStorageKey = "glint.media-task", disabled = false, onUseVideo, onBusyChange }: MediaWorkshopProps) {
  const [workflowOpened, setWorkflowOpened] = useState(false);
  const [type, setType] = useState<string>(initialType), [models, setModels] = useState<{id:string;name:string;description?:string;tags?:string[]}[]>([]), [model, setModel] = useState(""), [prompt, setPrompt] = useState(initialPrompt), [params, setParams] = useState("{}"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
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
    try { const saved = JSON.parse(localStorage.getItem(taskStorageKey) ?? "null"); if (typeof saved?.taskId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.taskId)) setJob({ taskId: saved.taskId }); else if (saved?.requestId && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.requestId)) setRecovery(saved.requestId); } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => { if (job) try { localStorage.setItem(taskStorageKey, JSON.stringify({ taskId: job.taskId })); } catch { /* Storage is optional. */ } }, [job?.taskId]);
  useEffect(() => {
    if (!recovery) return;
    const controller = new AbortController();
    void fetch(`/api/media/request/${recovery}`, { signal: controller.signal }).then(async response => {
      const data = await response.json(); if (controller.signal.aborted) return; if (!response.ok) throw new Error("提交回执未确认，请查询网关任务后再生成。");
      setJob(data); setRecovery(null); setPaused(false); setError("");
    }).catch(error => { if (!controller.signal.aborted) { setPaused(true); setError(error.message); } });
    return () => controller.abort();
  }, [recovery, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/media/models?type=${type}`, { signal: controller.signal }).then(response => response.json()).then(data => {
      if (controller.signal.aborted) return;
      if (data.protocol === "openai-images") { setProtocol("openai-images"); if (onUseVideo) { setModels([]); setModel(""); return; } if (type !== "image") { setType("image"); return; } }
      else if (data.protocol === "skills") setProtocol("skills");
      setModels(data.models ?? []); setModel(data.models?.[0]?.id ?? "");
    }).catch(() => {});
    return () => controller.abort();
  }, [type, Boolean(onUseVideo)]);
  useEffect(() => {
    if (!job || job.isFinal) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/media/status/${job.taskId}`, { signal: controller.signal });
        const data = await response.json(); if (controller.signal.aborted) return; if (!response.ok) throw new Error(data.error);
        setJob(data); if (!data.isFinal) timer = setTimeout(() => void poll(), 10000);
      } catch (error) { if (!controller.signal.aborted) { setPaused(true); setError(error instanceof Error ? error.message : "任务查询失败"); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.taskId, job?.isFinal, retry]);
  const selected = models.find(item => item.id === model);
  const running = Boolean(recovery || job && !job.isFinal);
  useEffect(() => { onBusyChange?.(busy || running); }, [busy, running, onBusyChange]);
  useEffect(() => { setConfirmed(false); }, [model, prompt, params]);
  return <section aria-label="素材工坊" className="tool-page">
    <header className="tool-page-head">
      <span className="g-label">素材 · 生成</span>
      <h2 className="g-title" style={{ margin: 0 }}>素材工坊</h2>
      <p className="g-sub">一句描述生成图片、短视频或配乐；结果写入当前服务的素材库。</p>
    </header>
    <Suspense fallback={<p role="status">{t("comfy.loading")}</p>}><MediaExecutionPanel storageKey={taskStorageKey} initialPrompt={initialPrompt} disabled={disabled} onUseVideo={onUseVideo} useVideoLabel={useVideoLabel} onBusyChange={onBusyChange} /></Suspense>
    <div className="tool-block" role="group" aria-label="生成素材">
      <div className="tool-block-head">
        <h3>生成</h3>
        <span className="g-label g-num">{openaiImages ? "OpenAI Images" : "Skills"} · {TYPE_LABEL[type] ?? type}</span>
      </div>
      <div className="tool-grid-2">
        <label className="g-form-row"><span>素材类型</span><select className="g-field tool-select" aria-label="素材类型" disabled={disabled || busy || openaiImages || running || Boolean(onUseVideo)} value={type} onChange={event => { setType(event.target.value); setModels([]); setModel(""); setJob(null); setError(""); }}><option value="image">图片 / 图片编辑</option><option value="video" disabled={openaiImages}>短视频{openaiImages ? "（需 skills 协议）" : ""}</option><option value="audio" disabled={openaiImages}>配乐 / 语音{openaiImages ? "（需 skills 协议）" : ""}</option></select></label>
        <label className="g-form-row"><span>媒体模型</span><select className="g-field tool-select" aria-label="媒体模型" value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      {openaiImages && <p className="tool-note" role="note">当前为 OpenAI Images 协议：只支持图片，同步出图。视频与配乐请在「模型连接 → 媒体服务」切换为 skills 协议。</p>}
      {!models.length && <p className="tool-note">{openaiImages ? "OpenAI Images 协议下没有可用的图片模型。请在网关侧确认 gpt-image 系模型可用，并保存一次设置以刷新模型列表。" : <>尚未配置媒体网关，或当前类型没有可用模型。<a className="g-link" href="#/settings">在设置中配置媒体服务</a></>}</p>}
      {selected && <div aria-label="模型说明" className="tool-band">
        {selected.description && <p className="tool-note" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{selected.description.replace(/—|–/g, "-")}</p>}
        <div className="tool-actions">
          {selected.tags?.slice(0, 6).map(tag => <span key={tag} className="g-chip">{tag}</span>)}
          <PriceCard modelId={selected.id} />
        </div>
      </div>}
      <label className="g-form-row"><span>描述</span><textarea className="g-field" aria-label="素材描述" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述主体、风格、构图和要修改的部分" /></label>
      {type === "image" && <div className="tool-actions" aria-label="图片编辑预设">
        {Object.entries(IMAGE_EDIT_PRESETS).map(([id, text]) => <button key={id} type="button" className="g-chip tool-preset" onClick={() => setPrompt(text)}>{id === "remove-bg" ? "白底改图（提示词）" : id === "upscale" ? "清晰精修（提示词）" : id}</button>)}
      </div>}
      <details className="tool-details">
        <summary>模型参数与参考素材</summary>
        <div className="tool-block" style={{ paddingTop: "var(--s-2, 8px)" }}>
          <textarea className="g-field" aria-label="媒体模型参数" rows={4} value={params} onChange={event => setParams(event.target.value)} />
          <p className="tool-note">按模型文档填 JSON；参考图可填网关支持的公网地址，只有点击生成才会发送。Suno 纯音乐：{"{\"make_instrumental\":\"instrumental\",\"mv\":\"v6-mini\"}"}</p>
        </div>
      </details>
      <div className="tool-actions">
        {onUseVideo && <label className="tool-check"><input type="checkbox" checked={confirmed} disabled={disabled || busy || running} onChange={event => setConfirmed(event.target.checked)} />{t("creation.confirmCost")}</label>}
        <button type="button" className="g-btn g-btn--primary" disabled={disabled || busy || !model || !prompt.trim() || running || Boolean(onUseVideo && !confirmed)} onClick={async () => {
          setBusy(true); setError("");
          try {
            const parsed = JSON.parse(params), signature = JSON.stringify([type, model, prompt, parsed]);
            if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
            try { localStorage.setItem(taskStorageKey, JSON.stringify({ requestId: request.current.id })); } catch {}
            const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, model, prompt, params: parsed, requestId: request.current.id }), signal: AbortSignal.timeout(openaiImages ? 240_000 : 40_000) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error);
            setJob(data);
          } catch (error) { const message = error instanceof Error ? error.message : "生成失败"; setError(openaiImages && /only generates images/i.test(message) ? "当前网关协议只支持图片；视频/配乐请先在「模型连接 → 媒体服务」切换为 skills 协议。" : message); if (request.current) { setRecovery(request.current.id); setPaused(true); } }
          finally { setBusy(false); }
        }}>{busy ? "提交中…" : "生成素材"}</button>
        {paused && <button type="button" className="g-btn" onClick={() => { setPaused(false); setError(""); setRetry(value => value + 1); }}>恢复查询（不重新生成）</button>}
        {recovery && <button type="button" className="g-btn g-btn--quiet" onClick={() => { setRecovery(null); setPaused(false); try { localStorage.removeItem(taskStorageKey); } catch {} }}>停止查询</button>}
        {job?.isFinal && <button type="button" className="g-btn g-btn--quiet" onClick={() => { setJob(null); request.current = null; try { localStorage.removeItem(taskStorageKey); } catch {} }}>新建素材任务</button>}
        {job && !job.isFinal && <button type="button" className="g-btn g-btn--quiet" onClick={async () => {
          try {
            const response = await fetch(`/api/media/cancel/${job.taskId}`, { method: "POST" });
            const data = await response.json(); if (!response.ok) throw new Error(data.error);
            setJob(data);
          } catch (error) { setError(error instanceof Error ? error.message : "取消失败"); }
        }}>取消等待</button>}
      </div>
      {job && <p role="status" className="tool-meta"><span className={job.isFinal ? "g-dot" : "g-dot g-dot--warn"} aria-hidden="true" />任务 {job.taskId} · {job.state ?? "已提交"}</p>}
      {job?.state === "cancelled" && <p role="note" className="tool-note">已本地取消：不再查询或下载该任务；上游可能照常完成并计费，费用以网关账单为准。</p>}
      {error && <p role="alert" className="tool-alert">{error}</p>}
      {job?.assetUrl && <div className="tool-block">
        {/\.(png|jpg|webp)$/.test(job.assetUrl) ? <img alt="生成的素材" src={applicationUrl(job.assetUrl)} className="tool-preview" /> : job.assetUrl.endsWith(".mp4") ? <video controls src={applicationUrl(job.assetUrl)} className="tool-preview" /> : <audio controls src={applicationUrl(job.assetUrl)} />}
        <div className="tool-actions"><a className="g-btn g-btn--sm" href={applicationUrl(job.assetUrl)} download>下载素材</a>{onUseVideo && job.isFinal && /^\/api\/media\/assets\/[a-zA-Z0-9_-]{1,100}\.mp4$/.test(job.assetUrl) && <Button disabled={disabled} onClick={() => void onUseVideo({ url: job.assetUrl!, origin: "generated", source: job.taskId })}>{useVideoLabel}</Button>}</div>
      </div>}
    </div>
    <div className="tool-block" role="group" aria-label="最近素材与版本">
      <div className="tool-block-head">
        <h3>最近素材</h3>
        <span className="g-label g-num">{library.length ? `${Math.min(library.length, 12)} / ${library.length}` : "0"}</span>
      </div>
      {onUseVideo && <div className="creation-media-recent" aria-label={t("creation.existing")}>{library.filter(asset => /^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(asset.name) && asset.url === `/api/media/assets/${asset.name}`).slice(0, 12).map(asset => <Button key={asset.name} size="sm" disabled={disabled} onClick={() => void onUseVideo({ url: asset.url, origin: "footage" })}>{asset.name}</Button>)}</div>}
      {library.length ? <div className="tool-thumbs">{library.filter(asset => /\.(png|jpg|webp)$/i.test(asset.name)).slice(0, 12).map(asset => (
        <button key={asset.name} type="button" onClick={() => setCandidate(asset.url)} className="tool-thumb">
          <img src={applicationUrl(asset.url)} alt={asset.name} width={96} height={54} />
          <span>{asset.name}</span>
        </button>
      ))}</div> : <p className="tool-note">还没有素材。生成或编辑图片后会出现在这里。</p>}
      {candidate && <img src={applicationUrl(candidate)} alt="当前候选" className="tool-preview" style={{ maxHeight: 240 }} />}
      {versions.length > 0 && <div className="tool-block">
        <span className="g-label">编辑版本链</span>
        <div className="tool-list">
          {versions.slice(-10).reverse().map(version => (
            <button key={version.file} type="button" onClick={() => setCandidate(version.url)} className="tool-quiet-row">
              <span className="g-num">{version.file}{version.parent ? ` ← ${version.parent}` : ""}{version.model ? ` · ${version.model}` : ""}{version.cost !== undefined ? ` · ${version.cost} 算力` : ""}</span>
              {version.prompt && <span className="tool-quiet-meta">{version.prompt.slice(0, 120)}</span>}
            </button>
          ))}
        </div>
      </div>}
    </div>
    {!onUseVideo && <><GatewayBackgroundEdit library={library} refreshLibrary={refreshLibrary} />
    <LocalImageTools /><LocalUpscale />
    <details className="tool-details" onToggle={event => { if (event.currentTarget.open) setWorkflowOpened(true); }}><summary>{t("comfy.title")}</summary>{workflowOpened && <Suspense fallback={<p role="status">{t("comfy.loading")}</p>}><ComfyWorkflowPanel refreshLibrary={refreshLibrary} /></Suspense>}</details></>}
  </section>;
}
/** Cost estimate for the selected model (GEN contract §8.4 estimate side). Unknown prices stay unknown, never 0. */
function PriceCard({ modelId }: { modelId: string }) {
  const [card, setCard] = useState<{ text: string; source: "gateway" | "unknown" } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setCard(null);
    void fetch(`/api/media/pricing/${encodeURIComponent(modelId)}`, { signal: controller.signal })
      .then(response => response.json())
      .then((data: { channel_groups?: Array<{ billing_method?: string; base_price?: number; is_active?: boolean; min_price?: number }> }) => {
        const group = data?.channel_groups?.find(entry => entry.is_active !== false) ?? data?.channel_groups?.[0];
        if (!group || !Number.isFinite(group.base_price)) { setCard({ text: "价格未知（以网关账单为准）", source: "unknown" }); return; }
        setCard({ text: `预计费用：${group.base_price} 算力/${group.billing_method === "按秒" ? "秒" : group.billing_method === "按次" ? "次" : group.billing_method ?? "调用"}（网关报价，实际以账单为准）`, source: "gateway" });
      })
      .catch(() => setCard({ text: "价格未知（以网关账单为准）", source: "unknown" }));
    return () => controller.abort();
  }, [modelId]);
  if (!card) return null;
  return <span aria-label="成本预估" className="g-num" style={{ color: card.source === "unknown" ? "var(--faint)" : "var(--warn)", fontSize: 11 }}>{card.text}</span>;
}
