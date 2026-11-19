import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { canonicalJson } from "@glintai/session";
import { parseNleProject, type NleProject } from "@glintai/scenescript";

const button: CSSProperties = { border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--ink-2)", color: "var(--paper-dim)", padding: "7px 11px", font: "inherit", fontSize: 12, cursor: "pointer" };
const field: CSSProperties = { minWidth: 0, width: "100%", boxSizing: "border-box", border: "1px solid var(--line-2)", borderRadius: 7, padding: 8, background: "var(--ink-2)", color: "var(--paper)", font: "inherit" };

/** Preserves aspect, normalized transforms and visible text size across project resolutions. */
export function updateNleProjectSettings(project: NleProject, longEdge: number | undefined, fps: number): NleProject {
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error("帧率需要在 1–120 fps 之间。");
  if (longEdge !== undefined && ![1280, 1920, 3840].includes(longEdge)) throw new Error("请选择支持的分辨率档位。");
  const ratio = longEdge === undefined ? 1 : longEdge / Math.max(project.width, project.height);
  const dimension = (value: number) => Math.round(value * ratio / 2) * 2;
  const width = longEdge === undefined ? project.width : dimension(project.width);
  const height = longEdge === undefined ? project.height : dimension(project.height);
  if (width < 16 || width > 7680 || height < 16 || height > 4320) throw new Error("该画幅在此档位超出支持范围，请选择其他档位。");
  const scale = height / project.height;
  const changedSize = width !== project.width || height !== project.height;
  const tracks = project.tracks.map(track => {
    if (!changedSize || scale === 1) return track;
    if (track.locked && track.clips.some(clip => clip.kind === "text")) throw new Error(`轨道「${track.name}」已锁定，请先解锁文字轨再改变分辨率。`);
    return { ...track, clips: track.clips.map(clip => {
      if (clip.kind !== "text") return clip;
      const fontSize = Math.round((clip.fontSize ?? 64) * scale * 100) / 100;
      if (fontSize < 12 || fontSize > 240) throw new Error(`片段「${clip.id}」缩放后的字号超出 12–240，请先调整字号。`);
      return { ...clip, fontSize };
    }) };
  });
  return parseNleProject({ ...project, width, height, fps, tracks });
}

export function NleProjectSettings({ project, onApply }: { project: NleProject; onApply(next: NleProject): boolean }) {
  const [open, setOpen] = useState(false), [resolution, setResolution] = useState("keep"), [fps, setFps] = useState(String(project.fps)), [error, setError] = useState("");
  return <>
    <button type="button" style={button} onClick={() => { setResolution("keep"); setFps(String(project.fps)); setError(""); setOpen(true); }}>项目规格</button>
    {open && createPortal(<section role="dialog" aria-label="项目规格" style={{ position: "fixed", zIndex: 100, right: 16, top: 70, width: "min(420px, calc(100vw - 32px))", boxSizing: "border-box", maxHeight: "80vh", overflow: "auto", padding: 16, border: "1px solid var(--line-2)", borderRadius: 12, background: "var(--ink-1)", color: "var(--paper)", boxShadow: "0 12px 40px #0008", display: "grid", gap: 12 }}>
      <strong>项目规格</strong>
      <small>当前 {project.width} × {project.height} · {project.fps} fps。片段时间码不变；导出时长按帧取整。</small>
      <label>画布分辨率<select aria-label="画布分辨率" value={resolution} style={field} onChange={event => setResolution(event.target.value)}>
        <option value="keep">保持当前分辨率</option><option value="1280">720p · 长边 1280</option><option value="1920">1080p · 长边 1920</option><option value="3840">4K · 长边 3840</option>
      </select></label>
      <label>帧率（1–120 fps）<input aria-label="项目帧率" style={field} type="number" min={1} max={120} step="any" value={fps} onChange={event => setFps(event.target.value)} /></label>
      <small>按当前画幅等比调整，文字字号随画布高度缩放；画幅取整可能有微小差异。不会提高素材原始清晰度；滤镜效果需重新检查。4K 更耗时和内存。</small>
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}><button type="button" style={button} onClick={() => {
        try {
          if (!fps.trim()) throw new Error("请输入帧率。");
          const next = updateNleProjectSettings(project, resolution === "keep" ? undefined : Number(resolution), Number(fps));
          if (canonicalJson(next) === canonicalJson(project)) { setError("规格没有变化。"); return; }
          if (onApply(next)) setOpen(false);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "无法应用规格。"); }
      }}>应用规格</button><button type="button" style={button} onClick={() => setOpen(false)}>取消</button></div>
    </section>, document.body)}
  </>;
}
