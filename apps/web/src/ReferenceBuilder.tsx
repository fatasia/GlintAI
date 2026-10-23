import { useEffect, useRef, useState, type CSSProperties } from "react";

const button: CSSProperties = { color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid currentColor", background: "transparent", color: "inherit", font: "inherit" };

/**
 * Reference video → reviewable project. Cuts and motion are inferred with local
 * FFmpeg analysis and reference frames are copied into the media library; the
 * user still replaces them with their own material before delivery.
 */
export type UploadReference = (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => Promise<{ name: string }>;
export function ReferenceBuilder({ onProject, disabled = false, uploadFile = uploadReferenceVideo }: { onProject(project: unknown): void; disabled?: boolean; uploadFile?: UploadReference }) {
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState<{ name: string; url: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [style, setStyle] = useState<Array<{ hex: string; share: number }>>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const loadLibrary = async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setError("");
    try {
      const response = await fetch("/api/media/library", { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (current.signal.aborted) return;
      const list = (Array.isArray(data.assets) ? data.assets : [])
        .filter((item: { name?: unknown }) => typeof item?.name === "string" && /^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(item.name))
        .map((item: { name: string }) => ({ name: item.name, url: `/api/media/assets/${item.name}` }));
      setVideos(list); setSelected(list[0]?.name ?? "");
    } catch { if (!current.signal.aborted) setError("无法读取素材库视频，请检查本地服务后重试。"); }
  };
  const build = async () => {
    if ((!selected && !file) || !consent || disabled || busy) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice("");
    try {
      let name = selected;
      if (file) {
        setNotice("正在上传参考片…"); setProgress(0);
        const uploadedBody = await uploadFile(file, percent => setProgress(percent), current.signal);
        if (!uploadedBody?.name) throw new Error("上传返回缺少文件名，请重试。");
        name = uploadedBody.name; setProgress(null);
        setSelected(name);
        setFile(null);
        setNotice("上传完成，正在切镜与生成工程…");
      }
      const response = await fetch("/api/reference/build", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }), signal: AbortSignal.any([current.signal, AbortSignal.timeout(180_000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? "已有参考分析在运行，请稍后再试。" : data?.error ?? "参考分析失败，请换一段视频重试。");
      if (current.signal.aborted) return;
      if (!data?.project) throw new Error("分析完成但没有生成工程，请重试。");
      onProject(data.project);
      const palette = Array.isArray(data.style?.palette) ? data.style.palette : [];
      setNotice(`已生成 ${Number(data.shots) || 0} 镜的可编辑工程（推断）${data.style?.medianShotMs ? ` · 主镜头约 ${(data.style.medianShotMs / 1000).toFixed(1)}s` : ""}。参考帧只用于本地预览，交付前请替换成自己的素材。`);
      setStyle(palette);
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "参考分析失败，请重试。"); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };

  return <details aria-label="从参考片重建工程" onToggle={event => { if (event.currentTarget.open) { setOpen(true); if (!videos.length) void loadLibrary(); } }}>
    <summary style={{ cursor: "pointer" }}>参考片 → 可审阅工程（推断）</summary>
    <div style={{ display: "grid", gap: 10, paddingTop: 10, minWidth: 0 }}>
      <small>本地切镜并抽帧，生成每镜一张参考图的工程骨架；切点、时长与机位都是启发式推断，不还原原片图层、骨架或人物。参考帧会进入素材库，交付前请替换。</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>上传参考片（MP4，≤300 MB）<input aria-label="上传参考片" type="file" accept="video/mp4" disabled={busy} onChange={event => { const next = event.target.files?.[0] ?? null; setFile(next); setError(""); if (next) setSelected(""); }} /></label>
        {file && <small>待上传：{file.name}{file.size ? ` · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ""}</small>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>或选素材库视频<select aria-label="选择参考片" style={{ ...field, minWidth: 180, width: "auto" }} value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{videos.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <button type="button" style={button} disabled={busy} onClick={() => void loadLibrary()}>刷新列表</button>
      </div>
      {!videos.length && !error && <p role="status" style={{ margin: 0 }}>素材库里还没有 MP4。可以先用媒体工坊生成，或把参考片放进素材库。</p>}
      <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认有权使用这段参考片，并会在交付前替换其中的参考帧</label>
      <button type="button" style={{ ...button, justifySelf: "start", opacity: !consent || (!selected && !file) || busy ? 0.5 : 1 }} disabled={!consent || (!selected && !file) || busy || disabled} onClick={() => void build()}>{busy ? "正在处理参考片…" : file ? "上传并生成工程" : "分析并生成工程"}</button>
      {open && busy && <small>分析可能需要十几秒；期间不要关闭页面。</small>}
      {progress !== null && <p role="status" style={{ margin: 0 }}>正在上传参考片… {progress}%</p>}
      {style.length > 0 && <div aria-label="参考片配色" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <small>提取的主色（推断）</small>
        {style.map(entry => <span key={entry.hex} title={`${entry.hex} · ${Math.round(entry.share * 100)}%`} style={{ width: 26, height: 26, borderRadius: 6, background: entry.hex, border: "1px solid rgba(255,255,255,.25)" }} />)}
      </div>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
  </details>;
}
/** XHR upload with byte progress; fetch cannot report upload progress. */
export function uploadReferenceVideo(file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<{ name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => { xhr.abort(); reject(new DOMException("Aborted", "AbortError")); };
    xhr.open("POST", "/api/reference/upload");
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error("上传失败，请检查网络后重试。"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && typeof body?.name === "string") resolve({ name: body.name });
        else reject(new Error(typeof body?.error === "string" ? body.error : "上传失败，请检查文件后重试。"));
      } catch { reject(new Error("上传响应无法解析，请重试。")); }
    };
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);
    xhr.onloadend = done;
    xhr.send(file);
  });
}