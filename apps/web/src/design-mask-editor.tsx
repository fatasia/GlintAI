import { useCallback, useEffect, useRef, useState } from "react";
import { appFetch, applicationUrl } from "./app-url";
import { executionBindings, executionRequest, type ExecutionQuote } from "./media-execution-client";
import { buildSubmissionInput, compositeMaskedPixels, dataUrlBytes, libraryAssetName, maskDiffStats, maskIsEmpty, sha256Hex, type MaskStats, type Rgba } from "./design-mask-edit";
import { optimizeDesignImage } from "./design-image-optimize";

// Per-image restore scope: a key without the source would restore strokes onto a
// different picture after the page image changed between sessions. FNV-1a is
// sufficient for a storage namespace (not a cryptographic context).
const imageFingerprint = (imageSrc: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < imageSrc.length; i++) { hash ^= imageSrc.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const storageKey = (projectId: string, imageSrc: string) => `glint.design-mask:${projectId}:${imageFingerprint(imageSrc)}`;
const BRUSH_SIZES = [8, 24, 48];
const PAGE_COPY_LIMIT = 512 * 1024;
type Stroke = { points: Array<[number, number]>; erase: boolean };
type Binding = { id: string; modelId: string; accountId: string; ready: boolean; entry?: { id: string; kind: string; name: string; adapter: { type: string; model: string }; capabilities: string[] } };
type Saved = { requestId: string; taskId?: string; strokes: Stroke[]; prompt: string; bindingId: string; size: number };

const makeCanvas = (width: number, height: number) => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("浏览器无法创建画布。"); return { canvas, context }; };
const toRgba = (context: CanvasRenderingContext2D, width: number, height: number): Rgba => ({ data: context.getImageData(0, 0, width, height).data, width, height });
const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("页面图片读取失败，请重试。")); image.src = applicationUrl(src); });
const blobDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片编码失败。")); reader.readAsDataURL(blob); });
const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片编码失败。")), "image/png"));
// 掩膜是像素协议不是主题色：白=重绘、黑=保留，与 CLI 的 ffmpeg maskedmerge 同一约定。
const MASK_KEEP = "rgb(0, 0, 0)", MASK_EDIT = "rgb(255, 255, 255)";
/** Cover-fit the candidate into the original frame so mask coordinates stay meaningful. */
function drawCover(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number): Rgba {
  const { context } = makeCanvas(width, height);
  context.fillStyle = MASK_KEEP; context.fillRect(0, 0, width, height);
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
  context.drawImage(source, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  return toRgba(context, width, height);
}
function paintStrokes(canvas: HTMLCanvasElement, strokes: Stroke[], size: number) {
  const context = canvas.getContext("2d")!; const { width, height } = canvas;
  context.globalCompositeOperation = "source-over"; context.fillStyle = MASK_KEEP; context.fillRect(0, 0, width, height);
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    context.strokeStyle = MASK_EDIT; context.lineWidth = size; context.lineJoin = "round"; context.lineCap = "round";
    context.beginPath();
    stroke.points.forEach(([x, y], index) => index ? context.lineTo(x * width, y * height) : context.moveTo(x * width, y * height));
    if (stroke.points.length === 1) context.lineTo(stroke.points[0]![0] * width + 0.1, stroke.points[0]![1] * height);
    context.stroke();
  }
  context.globalCompositeOperation = "source-over";
}
export function DesignMaskEditor({ projectId, imageSrc, onClose, onAdopt, onNotice }: {
  projectId: string; imageSrc: string; onClose(): void; onAdopt(dataUrl: string): void; onNotice(message: string): void;
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([]), [size, setSize] = useState(BRUSH_SIZES[1]!), [erase, setErase] = useState(false);
  const [prompt, setPrompt] = useState(""), [bindings, setBindings] = useState<Binding[]>([]), [bindingId, setBindingId] = useState("");
  const [phase, setPhase] = useState<"prepare" | "paint" | "quote" | "running" | "compare">("prepare");
  const [quote, setQuote] = useState<ExecutionQuote | null>(null), [confirmed, setConfirmed] = useState(false), [cap, setCap] = useState("");
  const [task, setTask] = useState<{ requestId: string; taskId: string; state?: string; isFinal?: boolean } | null>(null);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const [result, setResult] = useState<{ candidateUrl: string; stats: MaskStats } | null>(null);
  const originalRef = useRef<Rgba | null>(null), originalUrlRef = useRef(""), compositeRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null), drawing = useRef<number | null>(null), pollRef = useRef<AbortController | null>(null);
  const inputRef = useRef<ReturnType<typeof buildSubmissionInput> | null>(null);
  const binding = bindings.find(item => item.id === bindingId);
  useEffect(() => () => pollRef.current?.abort(), []);
  // Restore an in-flight task (and its strokes) so a reload never causes a double submission.
  useEffect(() => {
    let saved: Saved | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey(projectId, imageSrc)) ?? "null") as Saved | null; } catch { /* optional */ }
    if (saved && Array.isArray(saved.strokes)) {
      setStrokes(saved.strokes); setPrompt(saved.prompt ?? ""); setSize(saved.size || BRUSH_SIZES[1]!); setBindingId(saved.bindingId ?? "");
      if (saved.requestId && saved.taskId) void resume(saved.requestId, saved.taskId);
    }
    void prepare();
    void executionBindings().then(value => {
      const images = value.filter(item => item.ready && item.entry?.kind === "image") as Binding[];
      setBindings(images); setBindingId(current => current || (images.find(item => item.entry?.capabilities?.includes("reference-image"))?.id ?? images[0]?.id ?? ""));
    }).catch(failure => setError(failure instanceof Error ? failure.message : "模型绑定读取失败。"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (maskRef.current) paintStrokes(maskRef.current, strokes, size); }, [strokes, size, phase]);
  async function prepare() {
    try {
      const image = await loadImage(imageSrc), { context } = makeCanvas(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, 0, 0); originalRef.current = toRgba(context, image.naturalWidth, image.naturalHeight); originalUrlRef.current = imageSrc;
      setPhase(current => current === "prepare" ? "paint" : current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "页面图片读取失败。"); }
  }
  async function resume(requestId: string, taskId: string) {
    setTask({ requestId, taskId }); setPhase("running"); setStatus("正在恢复任务状态…");
    try { const known = await executionRequest<{ taskId: string }>(`request/${requestId}`); void poll(known.taskId ?? taskId); }
    catch { void poll(taskId); }
  }
  const poll = useCallback(async (taskId: string) => {
    pollRef.current?.abort(); const controller = new AbortController(); pollRef.current = controller;
    while (!controller.signal.aborted) {
      try {
        const current = await executionRequest<{ taskId: string; state?: string; isFinal?: boolean; assetUrl?: string }>(`status/${taskId}`);
        if (controller.signal.aborted) return;
        setTask(previous => ({ ...previous!, ...current, taskId }));
        setStatus(current.isFinal ? "" : `任务 ${current.state ?? "pending"}…`);
        if (current.isFinal) {
          if (current.state === "success" && current.assetUrl) { void buildCandidate(current.assetUrl); setPhase("compare"); return; }
          setError(current.state === "cancelled" ? "任务已取消；页面未修改。" : `任务失败（${current.state ?? "未知"}）；页面未修改，可重新报价提交。`);
          setPhase("paint"); return;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "任务状态查询失败；任务可能仍在执行。"); setPhase("paint"); return;
      }
    }
  }, []);
  async function buildCandidate(assetUrl: string) {
    const original = originalRef.current;
    if (!original) throw new Error("原图已不可用，无法合成；请重新打开。");
    const response = await appFetch(assetUrl); if (!response.ok) throw new Error("候选图片下载失败；页面未修改。");
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const generated = drawCover(bitmap, bitmap.width, bitmap.height, original.width, original.height);
      const mask = toRgba(maskRef.current!.getContext("2d", { willReadFrequently: true })!, original.width, original.height);
      const composited = compositeMaskedPixels(original, generated, mask);
      const { canvas, context } = makeCanvas(original.width, original.height);
      context.putImageData(new ImageData(new Uint8ClampedArray(composited.data), original.width, original.height), 0, 0);
      compositeRef.current = canvas;
      setResult({ candidateUrl: canvas.toDataURL("image/png"), stats: maskDiffStats(original, composited, mask) });
    } finally { bitmap.close(); }
  }
  async function requestQuote() {
    setError("");
    try {
      const original = originalRef.current!;
      const mask = toRgba(maskRef.current!.getContext("2d", { willReadFrequently: true })!, original.width, original.height);
      if (maskIsEmpty(mask)) throw new Error("请先在图片上涂抹要修改的区域；空掩膜不会提交。");
      const bytes = imageSrc.startsWith("data:") ? dataUrlBytes(imageSrc) : new Uint8Array(await (await appFetch(applicationUrl(imageSrc))).arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      let name = libraryAssetName(imageSrc);
      if (!name) {
        const mime = /^data:image\/(png|jpeg|webp);base64,/.exec(imageSrc)?.[1] ?? "png";
        const upload = await appFetch("/api/media/import-image", { method: "POST", headers: { "content-type": mime === "jpeg" ? "image/jpeg" : `image/${mime}` }, body: bytes });
        const saved = await upload.json();
        if (!upload.ok || typeof saved.name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(saved.name)) throw new Error("原图未能存入受控素材库，未提交任务。");
        name = saved.name as string;
      }
      const input = buildSubmissionInput({ bindingId, model: binding?.entry?.adapter.model ?? "", prompt, referenceImage: name, referenceSha256: sha256 });
      const price = await executionRequest<ExecutionQuote>("quote", input);
      inputRef.current = input; setQuote(price); setCap(String(price.amount)); setPhase("quote");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "报价失败，未提交任务。"); }
  }
  async function approveAndSubmit() {
    const input = inputRef.current;
    if (!quote || !input) return;
    setError(""); const requestId = crypto.randomUUID();
    try {
      await executionRequest("approve", { quoteId: quote.id, requestId, capCny: Number(cap), confirmed: true });
      const started = await executionRequest<{ taskId: string }>("submit", { ...input, quoteId: quote.id, requestId });
      try { localStorage.setItem(storageKey(projectId, imageSrc), JSON.stringify({ requestId, taskId: started.taskId, strokes, prompt, bindingId, size } satisfies Saved)); } catch { /* optional */ }
      setQuote(null); setTask({ requestId, taskId: started.taskId }); setPhase("running"); setStatus("已提交…");
      void poll(started.taskId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "提交失败；未批准的任务不会执行。"); }
  }
  async function cancelTask() {
    if (!task) return;
    try { await executionRequest(`cancel/${task.taskId}`, {}); setError(""); setStatus("已请求取消；任务不再回传结果，页面未修改。"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "取消失败；任务可能已结束。"); }
  }
  async function adopt() {
    try {
      const canvas = compositeRef.current!;
      let blob = await canvasBlob(canvas);
      const full = await appFetch("/api/media/import-image", { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      if (blob.size > PAGE_COPY_LIMIT) blob = await optimizeDesignImage(blob);
      onAdopt(await blobDataUrl(blob));
      if (!full.ok) onNotice("完整分辨率合成未能存入素材库；页面已使用压缩副本。");
      try { localStorage.removeItem(storageKey(projectId, imageSrc)); } catch { /* optional */ }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "采纳失败，页面未修改。"); }
  }
  function undoStroke() { setStrokes(current => current.slice(0, -1)); }
  const pending = phase === "running";
  return <dialog className="design-mask-dialog" aria-label="局部修改（掩膜）" ref={node => { if (node && !node.open) node.showModal(); }} onClose={onClose}>
    <header><strong>局部修改（掩膜）</strong><span className="g-label">涂过的区域按描述重画，其余像素保持不变 · 与「整图重生」不同</span><button type="button" onClick={() => { pollRef.current?.abort(); onClose(); }}>关闭</button></header>
    {phase === "prepare" && <p role="status">正在读取原图…</p>}
    <div className="design-mask-body">
      <div className="design-mask-canvas-wrap">
        <img src={applicationUrl(imageSrc)} alt="" className="design-mask-base" draggable={false} />
        <canvas ref={maskRef} width={originalRef.current?.width || 1} height={originalRef.current?.height || 1} className="design-mask-canvas" aria-label="掩膜画布"
          onPointerDown={event => { if (pending || phase === "compare") return; event.currentTarget.setPointerCapture(event.pointerId); drawing.current = event.pointerId; const box = event.currentTarget.getBoundingClientRect(); setStrokes(current => [...current, { points: [[(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]], erase }]); }}
          onPointerMove={event => { if (drawing.current !== event.pointerId) return; const box = event.currentTarget.getBoundingClientRect(); setStrokes(current => { const last = current.at(-1); if (!last) return current; if (last.points.length < 600) last.points.push([(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]); return [...current]; }); }}
          onPointerUp={event => { if (drawing.current === event.pointerId) { drawing.current = null; setStrokes(current => [...current]); } }}
          onPointerCancel={() => { drawing.current = null; }} />
      </div>
      <div className="design-mask-controls">
        <span className="g-label">掩膜工具</span>
        <div role="group" aria-label="笔刷大小" className="design-mask-tools">
          {BRUSH_SIZES.map(value => <button key={value} type="button" aria-pressed={size === value && !erase} onClick={() => { setSize(value); setErase(false); }} title={`笔刷 ${value}px`}>{value}px</button>)}
          <button type="button" aria-pressed={erase} onClick={() => setErase(true)}>橡皮</button>
          <button type="button" disabled={!strokes.length} onClick={undoStroke}>撤销笔画</button>
          <button type="button" disabled={!strokes.length} onClick={() => setStrokes([])}>清空</button>
        </div>
        <label>修改描述<textarea aria-label="修改描述" rows={3} maxLength={4000} disabled={pending} value={prompt} placeholder="只描述掩膜区域的变化，例如「把左下角的招牌换成蓝色霓虹字」。其余区域不会改动。" onChange={event => setPrompt(event.target.value)} /></label>
        <label>模型绑定<select aria-label="模型绑定" disabled={pending} value={bindingId} onChange={event => setBindingId(event.target.value)}>
          <option value="">—</option>
          {bindings.map(item => <option key={item.id} value={item.id}>{item.entry?.name ?? item.modelId} · {item.accountId}{item.entry?.capabilities?.includes("reference-image") ? " · 支持参考图" : ""}</option>)}
        </select></label>
        {!bindings.length && <p className="design-hint">还没有可用的图片模型绑定。请到「工具与设置 → 模型连接」绑定一个支持图片参考的图片模型后重试。</p>}
        {phase !== "quote" && phase !== "compare" && <button type="button" className="design-primary" disabled={pending || !strokes.length || !prompt.trim() || !bindingId} onClick={() => void requestQuote()}>{pending ? "任务进行中…" : "获取报价"}</button>}
        {quote && phase === "quote" && <section className="design-mask-quote" aria-label="费用确认">
          <p>预计费用 <strong>{quote.amount.toFixed(4)} {quote.unit}</strong>（本地估价，非最终账单）</p>
          <label>费用上限<input aria-label="费用上限" type="number" min={quote.amount} step="0.0001" value={cap} onChange={event => { setCap(event.target.value); setConfirmed(false); }} /></label>
          <label className="design-mask-confirm"><input type="checkbox" aria-label="确认费用" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认这笔费用并提交任务</label>
          <button type="button" className="design-primary" disabled={!confirmed || !Number.isFinite(Number(cap)) || Number(cap) < quote.amount || quote.expiresAt <= Date.now()} onClick={() => void approveAndSubmit()}>批准并提交</button>
          <button type="button" onClick={() => { setQuote(null); setPhase("paint"); }}>返回修改</button>
        </section>}
        {pending && <div className="design-mask-running">
          <p role="status">{status || "任务执行中…"}</p>
          <span className="g-label">任务 {task?.taskId}</span>
          <button type="button" onClick={() => void cancelTask()}>取消任务</button>
        </div>}
        {result && phase === "compare" && <section className="design-mask-compare" aria-label="候选对比">
          <p className="g-label">左：原图 · 右：掩膜合成候选（真实候选与原图按掩膜合成）</p>
          <div className="design-mask-sides">
            <img src={applicationUrl(originalUrlRef.current)} alt="原图" />
            <img src={result.candidateUrl} alt="掩膜合成候选" />
          </div>
          <small>像素统计：掩膜外 {result.stats.outsideChangedPixels} / {result.stats.outsidePixels} 像素变化（最大 {result.stats.maxOutsideDelta}），掩膜内 {result.stats.insideChangedPixels} / {result.stats.insidePixels} 像素变化（平均 {result.stats.meanInsideDelta}）。</small>
          <div className="design-mask-actions">
            <button type="button" className="design-primary" onClick={() => void adopt()}>采纳并替换页面图片</button>
            <button type="button" onClick={() => { setResult(null); setPhase("paint"); setStatus(""); try { localStorage.removeItem(storageKey(projectId, imageSrc)); } catch { /* optional */ } }}>放弃候选</button>
          </div>
        </section>}
        {error && <p role="alert" className="design-mask-error">{error}</p>}
      </div>
    </div>
  </dialog>;
}
