import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { button, field, label, select } from "./ui-tokens";
import { checkedOutputSize, removeKeyColor } from "./local-image";

/** Browser colour-key/resize and optional cutout on the current Glint server. */
export function LocalImageTools() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"key" | "scale" | "ai">("key");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [color, setColor] = useState("#ffffff"), [tolerance, setTolerance] = useState(8), [feather, setFeather] = useState(4), [scale, setScale] = useState(2);
  const [result, setResult] = useState<{ url: string; width: number; height: number; name: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  useEffect(() => { const controller = new AbortController(); void fetch("/api/local-cutout", { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => setAiConfigured(data?.configured === true)).catch(() => {}); return () => controller.abort(); }, []);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  function clearResult() { generation.current++; request.current?.abort(); request.current = null; setResult(null); setError(""); setBusy(false); }
  async function process() {
    if (!file || busy) return;
    const current = ++generation.current;
    setBusy(true); setError(""); setResult(null);
    let bitmap: ImageBitmap | undefined;
    try {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size < 1 || file.size > 20 * 1024 * 1024) throw new Error("请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片。");
      bitmap = await createImageBitmap(file);
      if (mode === "ai") {
        if (file.size > 4 * 1024 * 1024 || bitmap.width * bitmap.height > 4_000_000) throw new Error("智能抠图输入最多 4 MiB、400 万像素。");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        if (current !== generation.current) return;
        const controller = new AbortController(); request.current = controller;
        const response = await fetch("/api/local-cutout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64: btoa(binary) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]) });
        if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "本地智能抠图失败。"); }
        const blob = await response.blob();
        if (blob.type !== "image/png") throw new Error("智能抠图返回的不是 PNG，请重试或检查服务。");
        let output: ImageBitmap;
        try { output = await createImageBitmap(blob); } catch { throw new Error("智能抠图结果无法解码，请重试或检查服务。"); }
        try {
          if (current !== generation.current) return;
          if (output.width !== bitmap.width || output.height !== bitmap.height) throw new Error("智能抠图结果尺寸与原图不一致，请重试或检查服务。");
          setResult({ url: URL.createObjectURL(blob), width: output.width, height: output.height, name: `${file.name.replace(/\.[^.]+$/, "")}-cutout.png` });
        } finally { output.close(); }
        return;
      }
      const size = checkedOutputSize(bitmap.width, bitmap.height, mode === "scale" ? scale : 1);
      const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: mode === "key" });
      if (!context) throw new Error("当前浏览器无法处理图片。");
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      if (mode === "key") {
        const pixels = context.getImageData(0, 0, size.width, size.height);
        removeKeyColor(pixels.data, [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as [number, number, number], tolerance, feather);
        context.putImageData(pixels, 0, 0);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG 导出失败。")), "image/png"));
      if (current !== generation.current) return;
      setResult({ url: URL.createObjectURL(blob), ...size, name: `${file.name.replace(/\.[^.]+$/, "")}-${mode === "key" ? "transparent" : `${scale}x`}.png` });
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : "图片处理失败。"); }
    finally { bitmap?.close(); if (current === generation.current) { request.current = null; setBusy(false); } }
  }
  return <section aria-label="本地抠图和放大" style={{ display: "grid", gap: 10, padding: "16px 0", borderTop: "1px solid var(--line-2)" }}>
    <h3 style={{ margin: 0 }}>本地抠图与放大</h3>
    <small>纯色抠图和插值放大在浏览器处理；智能抠图发送到当前 Glint 服务处理，不调用外部网关，原文件不变。</small>
    <label style={label}>选择图片<input aria-label="选择本地图片" style={field} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { clearResult(); setFile(event.target.files?.[0] ?? null); }} /></label>
    <label style={label}>处理方式<select aria-label="本地图片处理方式" style={select} value={mode} onChange={event => { clearResult(); setMode(event.target.value as "key" | "scale" | "ai"); }}><option value="key">纯色背景抠图</option><option value="ai" disabled={!aiConfigured}>智能主体抠图{aiConfigured ? "" : "（未配置）"}</option><option value="scale">图片放大</option></select></label>
    {mode === "key" ? <>
      <small>按所选颜色生成透明 PNG，适合纯色背景；相近颜色的主体也可能被去除，不是智能识别主体。</small>
      <label style={label}>背景颜色<input aria-label="背景颜色" type="color" value={color} onChange={event => { clearResult(); setColor(event.target.value); }} /></label>
      <label style={label}>颜色容差 {tolerance}<input aria-label="颜色容差" type="range" min="0" max="40" value={tolerance} onChange={event => { clearResult(); setTolerance(Number(event.target.value)); }} /></label>
      <label style={label}>边缘羽化 {feather}<input aria-label="边缘羽化" type="range" min="0" max="20" value={feather} onChange={event => { clearResult(); setFeather(Number(event.target.value)); }} /></label>
    </> : mode === "ai" ? <small>使用当前 Glint 服务配置的 U²-Net 模型识别主体。图片最多 4 MiB、400 万像素；结果请检查细节。</small> : <><small>增加实际像素尺寸，采用浏览器插值，不会创造真实细节，不是 AI 超分。</small><label style={label}>放大倍率<select aria-label="放大倍率" style={select} value={scale} onChange={event => { clearResult(); setScale(Number(event.target.value)); }}><option value={2}>2×</option><option value={4}>4×</option></select></label></>}
    <button type="button" style={button} disabled={!file || busy} onClick={() => void process()}>{busy ? "处理中…" : mode === "scale" ? "放大并生成 PNG" : "生成透明 PNG"}</button>
    {error && <p role="alert">{error}</p>}
    {result && <div style={{ display: "grid", gap: 8 }}><span role="status">输出尺寸 {result.width} × {result.height}</span><img src={applicationUrl(result.url)} alt="本地处理结果" style={{ maxWidth: "100%", maxHeight: 300, objectFit: "contain", background: "repeating-conic-gradient(#aaa 0 25%, #eee 0 50%) 0 / 16px 16px" }} /><a href={applicationUrl(result.url)} download={result.name}>下载新 PNG</a></div>}
  </section>;
}
