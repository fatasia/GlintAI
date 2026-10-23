import { useEffect, useState } from "react";
import type { SavedProject } from "./project-history";

const selectStyle = { boxSizing: "border-box" as const, width: "100%", minWidth: 0, padding: "10px 12px", borderRadius: 10, border: "1px solid #2b2b31", background: "#101013", color: "#e4e4e7", font: "inherit", fontSize: 13 };

/**
 * GIF is an export shape of a finished project, not a separate generator.
 * Render the first six seconds here so the user does not need to open the
 * editor just to get one.
 */
export function QuickGif({ projects, disabled = false }: { projects: SavedProject[]; disabled?: boolean }) {
  const ready = projects.filter(project => project.project);
  const [id, setId] = useState(ready[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; file: string; bytes: number } | null>(null);
  useEffect(() => { if (!ready.some(project => project.id === id)) setId(ready[0]?.id ?? ""); }, [projects]);

  const render = async () => {
    const chosen = ready.find(project => project.id === id) ?? ready[0];
    if (!chosen?.project || busy) { if (!chosen) setError("还没有可导出的作品：先生成一支视频。"); return; }
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/project/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: chosen.project, format: "gif", frame: 0 }), signal: AbortSignal.timeout(200_000) });
      const data = await response.json();
      if (!response.ok || typeof data?.url !== "string" || typeof data?.file !== "string") throw new Error(typeof data?.error === "string" ? data.error : "GIF 导出失败");
      setResult({ url: data.url, file: data.file, bytes: Number(data.bytes) || 0 });
      const link = document.createElement("a"); link.href = data.url; link.download = data.file; link.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : "GIF 导出失败");
    } finally { setBusy(false); }
  };

  return <section aria-label="导出 GIF" style={{ display: "grid", gap: 12, minWidth: 0, padding: "20px 22px", background: "#151518", borderRadius: 18, boxShadow: "0 30px 80px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.045)" }}>
    <p style={{ margin: 0, color: "#e4e4e7", fontSize: 15, lineHeight: 1.6 }}>GIF 从已有作品导出：前 6 秒、50% 帧率，直接下载。</p>
    {ready.length > 0
      ? <select aria-label="选择要导出的作品" value={id} disabled={disabled || busy} onChange={event => setId(event.target.value)} style={selectStyle}>{ready.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      : <small style={{ color: "#8b8b95" }}>还没有作品。先在上面生成一支视频，再回来导出 GIF。</small>}
    <button type="button" disabled={disabled || busy || ready.length === 0} onClick={() => void render()} style={{ justifySelf: "start", border: "1px solid #f4f4f5", borderRadius: 999, padding: "9px 18px", font: "inherit", fontSize: 14, fontWeight: 600, cursor: disabled || busy || ready.length === 0 ? "not-allowed" : "pointer", background: "#f4f4f5", color: "#09090b", opacity: disabled || busy || ready.length === 0 ? 0.45 : 1 }}>{busy ? "正在渲染 GIF…" : "导出 GIF"}</button>
    {busy && <small role="status" style={{ color: "#8b8b95" }}>渲染在服务器上进行，通常需要 15–60 秒；完成后会自动下载。</small>}
    {result && <p role="status" style={{ margin: 0, color: "#a1a1aa", fontSize: 13 }}>已导出 {result.file} · {Math.round(result.bytes / 1024)} KB · <a href={result.url} download style={{ color: "#d4d4d8" }}>再下载一次</a></p>}
    {error && <p role="alert" style={{ margin: 0, color: "#fca5a5", fontSize: 13 }}>{error}</p>}
    <details style={{ color: "#8b8b95", fontSize: 12 }}><summary style={{ cursor: "pointer" }}>需要完整时长或 PNG？</summary><p style={{ margin: "8px 0 0", lineHeight: 1.6 }}>打开作品进入编辑器，右上角可导出当前镜 PNG；完整视频用 MP4。GIF 面向即时分享，因此只取前段。</p></details>
  </section>;
}
