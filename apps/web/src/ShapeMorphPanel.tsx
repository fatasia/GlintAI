import { useEffect, useState } from "react";
import { parseProject, sceneDurationMs, type SceneScriptProject } from "@glintai/scenescript";

const button = { background: "var(--ink-3)", border: "1px solid var(--line-2)", color: "var(--paper)", padding: "7px 11px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13 };

/** Keep this change in the existing project/session transaction rather than a separate animation state. */
export function setShapeMorph(project: SceneScriptProject, sceneId: string, durationMs: number | null, replace = false): SceneScriptProject {
  const index = project.scenes.findIndex(scene => scene.id === sceneId);
  if (index < 0) throw new Error("镜头不存在。");
  const scene = project.scenes[index]!;
  if (scene.locked) throw new Error("当前镜头已锁定，请先解锁。");
  if (durationMs === null && scene.transition?.in !== "shape-morph") throw new Error("当前镜头没有矩形形变。");
  if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs < 120 || durationMs > 1200)) throw new Error("形变时长须为 120 至 1200 毫秒的整数。");
  if (durationMs !== null && durationMs > sceneDurationMs(scene)) throw new Error("形变时长不能超过当前镜头时长。");
  if (durationMs !== null && scene.transition && scene.transition.in !== "shape-morph" && !replace) throw new Error("当前镜头已有入场转场；请确认替换。");
  const next = structuredClone(project);
  if (durationMs === null) delete next.scenes[index]!.transition;
  else next.scenes[index]!.transition = { in: "shape-morph", durationMs };
  const result = parseProject(next);
  return result;
}

export function ShapeMorphPanel({ project, sceneId, onChange }: { project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void }) {
  const sceneIndex = project.scenes.findIndex(scene => scene.id === sceneId);
  const scene = project.scenes[sceneIndex], previous = project.scenes[sceneIndex - 1];
  const [duration, setDuration] = useState("800"), [replace, setReplace] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    setDuration(String(scene?.transition?.in === "shape-morph" ? scene.transition.durationMs ?? 800 : scene ? Math.min(800, Math.max(120, sceneDurationMs(scene))) : 800));
    setReplace(false); setError("");
  }, [sceneId, scene?.transition?.in, scene?.transition?.durationMs, scene?.narration.durationMs, scene?.narration.text, scene?.narration.speakingRate]);
  const ids = new Map((previous?.elements ?? []).map(item => [item.id, item.kind]));
  const matched = (scene?.elements ?? []).filter(item => (item.kind === "rect" || item.kind === "path") && ids.get(item.id) === item.kind).map(item => item.id);
  const otherTransition = Boolean(scene?.transition && scene.transition.in !== "shape-morph");
  const apply = (value: number | null) => {
    try {
      const next = setShapeMorph(project, sceneId, value, replace);
      onChange(next); setError(""); setReplace(false); setNotice(value === null ? "已移除形变，可撤销。" : "已应用形变，可撤销。");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "";
      const message = detail.includes("identical explicit") ? "路径命令或数量不一致。两端请使用相同顺序的显式绝对 M/L/Q/C/Z 命令。"
        : detail.includes("viewBox must match") ? "路径画布尺寸不一致，请从前一镜复制路径后再编辑。"
        : detail.includes("disable draw-on") ? "请先关闭两镜匹配路径的逐笔动画。"
        : detail.includes("animation tracks") ? "请先移除两镜匹配对象的关键帧。"
        : detail.includes("shape-morph:") ? "请检查两镜均为内置场景，前镜无入场转场，两镜无动态镜头、效果或节拍；匹配色块外观须一致。"
        : detail || "无法应用形变，请检查镜头设置。";
      setNotice(""); setError(message);
    }
  };
  return <section aria-label="矩形形变转场" style={{ display: "grid", gap: 8, minWidth: 0, border: "1px solid var(--line-2)", borderRadius: 10, padding: 12 }}>
    <strong>相邻色块与路径形变</strong>
    <small>复制前一镜，关闭两镜路径的逐笔动画，再编辑同 ID 路径数据。路径须使用相同顺序和数量的显式绝对 M/L/Q/C/Z 命令、相同画布尺寸；不自动补点或重建形状。仅匹配对象参与形变，可撤销。</small>
    <small style={{ overflowWrap: "anywhere" }}>{previous ? `前一镜：${previous.id} · 匹配对象：${matched.length ? matched.join("、") : "无"}` : "第一镜没有前一镜。"}</small>
    <label>形变时长（毫秒）<input aria-label="形变时长" type="number" min={120} max={1200} step={10} value={duration} disabled={!scene || scene.locked} onChange={event => setDuration(event.target.value)} style={{ width: 100, maxWidth: "100%", boxSizing: "border-box" }} /></label>
    {otherTransition && <label><input type="checkbox" checked={replace} disabled={scene?.locked} onChange={event => setReplace(event.target.checked)} />替换当前入场转场</label>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button type="button" style={button} disabled={!scene || scene.locked || !previous || !matched.length || (otherTransition && !replace)} onClick={() => apply(Number(duration))}>应用形变</button>
      {scene?.transition?.in === "shape-morph" && <button type="button" style={button} disabled={scene.locked} onClick={() => apply(null)}>移除形变</button>}
    </div>
    {scene?.locked && <small>镜头已锁定。</small>}
    {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
    {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
  </section>;
}
