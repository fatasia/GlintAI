import { applicationUrl } from "./app-url";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { button, field, label, sub } from "./ui-tokens";

/** Optional on-device super-resolution, never sends data to a model gateway. */
export function LocalUpscale() {
  const [configured, setConfigured] = useState(false), [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; width: number; height: number; name: string } | null>(null);
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => { const controller = new AbortController(); void fetch("/api/local-upscale", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(v => { if (!controller.signal.aborted) setConfigured(v?.configured === true); }).catch(() => {}); return () => controller.abort(); }, []);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  function reset() { generation.current++; request.current?.abort(); request.current = null; setResult(null); setError(""); setBusy(false); }
  async function run() {
    if (!file || busy || !configured) return;
    const current = ++generation.current; setBusy(true); setError(""); setResult(null);
    try {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || !file.size || file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MiB 的 PNG、JPEG 或 WebP 图片。");
      const input = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let offset = 0; offset < input.length; offset += 8192) binary += String.fromCharCode(...input.subarray(offset, offset + 8192));
      if (current !== generation.current) return;
      const controller = new AbortController(); request.current = controller;
      const response = await fetch("/api/local-upscale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64: btoa(binary) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(250_000)]) });
      if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || "本地超分失败。"); }
      const blob = await response.blob(); if (blob.type !== "image/png") throw new Error("输出格式无效。");
      const bitmap = await createImageBitmap(blob);
      try {
        if (current !== generation.current) return;
        setResult({ url: URL.createObjectURL(blob), width: bitmap.width, height: bitmap.height, name: `${file.name.replace(/\.[^.]+$/, "")}-ai-4x.png` });
      } finally { bitmap.close(); }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : "本地超分失败。"); }
    finally { if (current === generation.current) { request.current = null; setBusy(false); } }
  }
  return <section aria-label="本地 AI 超分" style={{ display: "grid", gap: 10, padding: "16px 0", borderTop: "1px solid var(--line-2)" }}>
    <h3 style={{ margin: 0 }}>本地 AI 超分 · 4×</h3>
    <small>使用当前 Glint 服务配置的 Real-ESRGAN 模型；图片发送到当前服务，不调用外部网关。模型可能生成与原图不同的细节，请检查结果。</small>
    <p style={sub}>{configured ? "本地运行程序和模型已配置。" : "未配置运行程序和模型；可在服务端配置后使用。"}</p>
    <label style={label}>选择图片<input type="file" aria-label="选择 AI 超分图片" style={field} accept="image/png,image/jpeg,image/webp" onChange={e => { reset(); setFile(e.target.files?.[0] ?? null); }} /></label>
    <small>输入最多 4 MiB；4× 输出不超过 4096 像素/边和 1600 万像素。</small>
    <button type="button" style={button} disabled={!configured || !file || busy} onClick={() => void run()}>{busy ? "正在处理…" : "4× AI 超分"}</button>
    {busy && <button type="button" style={button} onClick={reset}>取消</button>}
    {error && <p role="alert">{error}</p>}
    {result && <div style={{ display: "grid", gap: 8 }}><span role="status">输出尺寸 {result.width} × {result.height}</span><img src={applicationUrl(result.url)} alt="AI 超分结果" style={{ maxWidth: "100%", maxHeight: 300, objectFit: "contain" }} /><a href={applicationUrl(result.url)} download={result.name}>下载 PNG</a></div>}
  </section>;
}
