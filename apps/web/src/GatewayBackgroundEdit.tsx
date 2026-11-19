import { applicationUrl } from "./app-url"; import { supportsMediaCapability } from "@glintai/models";
import { appFetch as fetch } from "./app-url";
import { useEffect, useState } from "react";
import { button, buttonPrimary, field, label, select, sub } from "./ui-tokens";
import { makeExpansionReference, verifyExpansionSize, type ExpansionSize } from "./gateway-expand";

const KEY = "glint.gateway-background.v1";
const MODEL = "tt-image-2.5";
type Asset = { name: string; url: string; bytes: number };
type Operation = "cutout" | "expand";
type Receipt = { requestId: string; taskId?: string; referenceName: string; operation?: Operation; targetSize?: ExpansionSize };
type Task = { taskId: string; state?: string; isFinal?: boolean; assetUrl?: string; cost?: number };
type PriceGroup = { is_active?: boolean; in_key_whitelist?: boolean; excluded_for_this_key?: boolean; supported_options?: { background?: string[] }; base_price?: number; billing_method?: string };

export async function verifyTransparentPng(blob: Blob) {
  if (blob.type !== "image/png") throw new Error("结果不是 PNG，未通过透明检查。");
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_777_216) throw new Error("结果尺寸超出透明检查范围。");
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("当前浏览器无法检查透明像素。");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let transparent = false, visible = false;
    for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) transparent = true; if (data[i]! > 0) visible = true; if (transparent && visible) break; }
    if (!transparent || !visible) throw new Error("结果未检测到透明背景和可见主体，请检查原图与网关结果。");
    return { width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

export function GatewayBackgroundEdit({ library, refreshLibrary }: { library: Asset[]; refreshLibrary: () => Promise<void> }) {
  const [modelsReady, setModelsReady] = useState(false), [imageSupported, setImageSupported] = useState(false), [transparentSupported, setTransparentSupported] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false), [checkRetry, setCheckRetry] = useState(0);
  const [operation, setOperation] = useState<Operation>("cutout"), [targetSize, setTargetSize] = useState<ExpansionSize>("1536x864");
  const [asset, setAsset] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null), [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState(""), [check, setCheck] = useState("");
  const [priceGroups, setPriceGroups] = useState<PriceGroup[] | null>(null), [priceLoaded, setPriceLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const assets = library.filter(item => /^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(item.name) && item.bytes > 0 && item.bytes <= 8 * 1024 * 1024);
  const background = operation === "cutout" ? "transparent" : "opaque";
  const available = imageSupported && (operation === "expand" || transparentSupported);
  const prices = (priceGroups ?? []).filter(group => group.is_active === true && group.in_key_whitelist !== false && group.excluded_for_this_key !== true &&
    (!group.supported_options?.background || group.supported_options.background.includes(background)) &&
    group.billing_method === "按次" && Number.isFinite(group.base_price)).map(group => group.base_price!);
  const price = !priceLoaded ? "价格查询中…" : prices.length ? `可用渠道基础价 ${Math.min(...prices)}–${Math.max(...prices)} 算力/次；参数、参考图或渠道切换可能影响实际费用，以网关账单为准。` : "价格未知，请先在网关核对费用。";

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/media/models?type=image", { signal: controller.signal }).then(response => response.json()).then(value => {
      const selected = value.protocol === "skills" && value.models?.find((item: { id: string }) => item.id === MODEL);
      setImageSupported(supportsMediaCapability(selected, value.protocol, "image-to-image"));
      setTransparentSupported(supportsMediaCapability(selected, value.protocol, "transparent-background"));
      setModelsReady(true);
    }).catch(() => { if (!controller.signal.aborted) setModelsReady(true); });
    void fetch(`/api/media/pricing/${MODEL}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) { await response.body?.cancel(); throw new Error("price unavailable"); } return response.json();
    }).then(value => { setPriceGroups(Array.isArray(value.channel_groups) ? value.channel_groups : []); setPriceLoaded(true); })
      .catch(() => { if (!controller.signal.aborted) setPriceLoaded(true); });
    try {
      const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (typeof value?.requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.requestId) && typeof value.referenceName === "string") {
        setReceipt(value);
        if (value.operation === "expand") { setOperation("expand"); if (value.targetSize === "1536x864" || value.targetSize === "864x1536") setTargetSize(value.targetSize); }
        if (typeof value.taskId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.taskId)) setTask({ taskId: value.taskId });
      }
    } catch { setError("无法读取上次任务回执；请检查本地存储后再提交。"); }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!receipt || task?.isFinal) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        let id = receipt.taskId;
        if (!id) {
          const response = await fetch(`/api/media/request/${receipt.requestId}`, { signal: controller.signal });
          if (!response.ok) throw new Error("提交状态尚未确认；请查询网关账单或稍后恢复查询，不要重复提交。");
          const value = await response.json(); id = value.taskId;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("任务回执无效，请检查网关。");
          const next = { ...receipt, taskId: id }; localStorage.setItem(KEY, JSON.stringify(next)); setReceipt(next);
        }
        const response = await fetch(`/api/media/status/${id}`, { signal: controller.signal });
        if (!response.ok) throw new Error("任务查询或结果下载失败；可恢复查询，不会重新生成。");
        const value = await response.json(); setTask(value); setError("");
        if (!value.isFinal) timer = setTimeout(() => void poll(), 10000); else void refreshLibrary();
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "任务查询失败。"); }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [receipt?.requestId, receipt?.taskId, task?.isFinal, retry]);

  useEffect(() => {
    if (!task?.isFinal || task.state !== "success") return;
    if (!task.assetUrl) { setCheck("任务完成，但没有可检查的结果素材；请查询网关。"); return; }
    const expansion = receipt?.operation === "expand";
    const size = receipt?.targetSize;
    const controller = new AbortController(); setCheckFailed(false); setCheck(expansion ? "正在检查输出尺寸…" : "正在检查透明像素…");
    void fetch(task.assetUrl, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error("无法读取结果。"); return response.blob(); })
      .then(blob => {
        if (expansion && size !== "1536x864" && size !== "864x1536") throw new Error("扩画任务缺少目标尺寸记录，请人工检查。");
        return expansion ? verifyExpansionSize(blob, size!) : verifyTransparentPng(blob);
      })
      .then(result => { if (!controller.signal.aborted) setCheck(expansion ? `输出尺寸检查通过 · ${result.width} × ${result.height}。模型可能重绘原图，请确认画面后再使用。` : `透明像素检查通过 · ${result.width} × ${result.height}。请检查主体边缘，模型可能改变原图细节。`); })
      .catch(e => { if (!controller.signal.aborted) { setCheckFailed(true); setCheck(e instanceof Error ? e.message : "结果检查失败。"); } });
    return () => controller.abort();
  }, [task?.isFinal, task?.state, task?.assetUrl, receipt?.operation, receipt?.targetSize, checkRetry]);

  async function submit() {
    if (busy || uploading || receipt || !available || !confirmed || !asset) return;
    if (!navigator.locks) { setError("当前浏览器不支持任务锁，无法安全提交；请使用较新的 Chrome、Edge 或客户端。"); return; }
    setBusy(true); setError("");
    let sentPossible = false;
    try {
      await navigator.locks.request("glint:gateway-background", { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("另一个页面正在提交抠图任务。");
        if (localStorage.getItem(KEY)) throw new Error("已有未清除的任务回执，请先恢复查询。");
        const source = assets.find(item => item.name === asset); if (!source) throw new Error("请选择有效的素材库图片。");
        const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error("素材读取失败。");
        let bytes = await response.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("参考图不能超过 8 MiB。");
        let referenceName = source.name;
        if (operation === "expand") {
          const type = source.name.endsWith(".png") ? "image/png" : source.name.endsWith(".jpg") ? "image/jpeg" : "image/webp";
          const prepared = await makeExpansionReference(new Blob([bytes], { type }), targetSize);
          const imported = await fetch("/api/media/import-image", { method: "POST", headers: { "content-type": "image/png" }, body: prepared, signal: AbortSignal.timeout(90_000) });
          if (!imported.ok) throw new Error("扩画参考图无法导入当前服务，请检查 FFmpeg。");
          const value = await imported.json();
          if (typeof value.name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.png$/.test(value.name)) throw new Error("扩画参考图回执无效。");
          referenceName = value.name; bytes = await prepared.arrayBuffer(); void refreshLibrary();
        }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
        const next: Receipt = { requestId: crypto.randomUUID(), referenceName: source.name, operation, ...(operation === "expand" ? { targetSize } : {}) };
        localStorage.setItem(KEY, JSON.stringify(next)); setReceipt(next);
        sentPossible = true;
        const sent = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(150000), body: JSON.stringify({
          type: "image", model: MODEL,
          prompt: operation === "expand" ? "以参考图中央画面为依据，自然延展场景，补全四周白色留白，使整幅画面连续完整；尽量保持中央主体外观、比例和风格，不要白边或相框。" : "以参考图为依据，移除背景并保留完整主体，输出真正透明背景的 PNG。",
          params: operation === "expand" ? { version: "flare", size: targetSize, background: "opaque", quality: "auto" } : { version: "flare", resolution: "1K", aspect_ratio: "1:1", background: "transparent", quality: "auto" },
          requestId: next.requestId, libraryReference: { name: referenceName, sha256: hash },
        }) });
        if (!sent.ok) throw new Error("提交状态未确认，请恢复查询，不要重复提交；可能产生费用。");
        const result = await sent.json();
        if (typeof result.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.taskId)) throw new Error("任务回执无效，请先查网关。");
        const saved = { ...next, taskId: result.taskId }; localStorage.setItem(KEY, JSON.stringify(saved)); setReceipt(saved); setTask({ taskId: result.taskId });
      });
    } catch (e) { setError(sentPossible ? "提交状态未确认，请恢复查询，不要重复提交；可能产生费用。" : e instanceof Error ? e.message : "提交失败。"); }
    finally { setBusy(false); }
  }

  async function importImage(file: File) {
    if (busy || uploading || receipt) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) {
      setError("请选择不超过 8 MiB 的 PNG、JPEG 或 WebP 图片。"); return;
    }
    setUploading(true); setError(""); setConfirmed(false);
    try {
      const response = await fetch("/api/media/import-image", { method: "POST", headers: { "content-type": file.type }, body: file, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error("图片导入失败，请检查格式、大小及服务器 FFmpeg。");
      const value = await response.json();
      if (typeof value.name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(value.name)) throw new Error("图片导入回执无效。");
      await refreshLibrary(); setAsset(value.name);
    } catch (e) { setError(e instanceof Error ? e.message : "图片导入失败。"); }
    finally { setUploading(false); }
  }

  return <section aria-label="网关图片编辑" style={{ display: "grid", gap: 10, padding: "16px 0", borderTop: "1px solid var(--line-2)" }}>
    <h3 style={{ margin: 0 }}>网关图片编辑</h3>
    <label style={label}>处理方式<select aria-label="网关图片处理方式" style={select} value={operation} disabled={busy || uploading || !!receipt} onChange={event => { setOperation(event.target.value as Operation); setConfirmed(false); setCheck(""); }}><option value="cutout">透明背景编辑</option><option value="expand">生成式扩画</option></select></label>
    {operation === "expand" ? <>
      <small>先将原图等比放入留白画布，再交给 TT Image 2.5 补全画面。模型可能重绘原图，尺寸以结果检查为准；这不是蒙版扩图或 AI 超分。</small>
      <label style={label}>目标画幅<select aria-label="扩画目标画幅" style={select} value={targetSize} disabled={busy || uploading || !!receipt} onChange={event => { setTargetSize(event.target.value as ExpansionSize); setConfirmed(false); }}><option value="1536x864">横屏 1536 × 864</option><option value="864x1536">竖屏 864 × 1536</option></select></label>
    </> : <small>将选中的素材库图片发送到 TT Image 2.5，可能计费。模型会重新生成图片，主体细节、构图和尺寸可能改变；结果会检查透明像素。</small>}
    <small>{modelsReady ? available ? operation === "expand" ? "已检测到图生图能力；扩画依靠提示词，不保证原图不变。" : "已检测到图生图与透明背景能力。" : "需要在模型连接中配置支持该模型的 skills 网关。" : "正在检查模型能力…"}</small>
    <small>{price}</small>
    <label style={label}>从本地导入图片<input aria-label="导入透明编辑图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || uploading || !!receipt} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importImage(file); }} /></label>
    <small>导入会把文件保存到当前 Glint 服务；确认生成后才发送给外部网关。</small>
    {uploading && <p role="status" style={sub}>正在校验并导入图片…</p>}
    <label style={label}>素材库图片<select aria-label="透明编辑参考图" style={select} value={asset} disabled={busy || uploading || !!receipt} onChange={event => { setAsset(event.target.value); setConfirmed(false); }}><option value="">选择图片（不超过 8 MiB）</option>{assets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
    <label style={field}><input type="checkbox" checked={confirmed} disabled={busy || uploading || !!receipt} onChange={event => setConfirmed(event.target.checked)} /> 我确认上传所选图片并接受网关可能计费</label>
    <button type="button" style={buttonPrimary} disabled={!available || !asset || !confirmed || busy || uploading || !!receipt} onClick={() => void submit()}>{busy ? "提交中…" : operation === "expand" ? "生成扩画" : "生成透明背景"}</button>
    {receipt && !task?.isFinal && <button type="button" style={button} onClick={() => { setError(""); setRetry(value => value + 1); }}>恢复查询（不重新生成）</button>}
    {task && <p style={sub} role="status">任务 {task.taskId} · {task.state ?? "查询中"}{typeof task.cost === "number" ? ` · ${task.cost} 算力` : ""}</p>}
    {check && <p role="status" style={sub}>{check}</p>}
    {checkFailed && task?.assetUrl && <button type="button" style={button} onClick={() => setCheckRetry(value => value + 1)}>重新检查已有结果（不重新生成）</button>}
    {task?.assetUrl && <><a href={applicationUrl(task.assetUrl)} download>下载生成结果</a><img src={applicationUrl(task.assetUrl)} alt="网关生成结果" style={{ maxWidth: "100%", maxHeight: 300, objectFit: "contain", background: "repeating-conic-gradient(#aaa 0 25%, #eee 0 50%) 0 / 16px 16px" }} /></>}
    {task?.isFinal && <button type="button" style={button} onClick={() => { localStorage.removeItem(KEY); setReceipt(null); setTask(null); setCheck(""); setCheckFailed(false); setError(""); setConfirmed(false); }}>新建任务</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
