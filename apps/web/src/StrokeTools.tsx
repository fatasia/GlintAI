import { useEffect, useRef, useState } from "react";
import { SceneElement, isStrokePath, sceneDurationMs, type Scene, type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { addElement } from "./shot-model";

type Stroke = Extract<SceneElement, { kind: "path" }>;
const input = { width: "100%", minWidth: 0, background: "var(--ink-2)", color: "var(--paper)", border: "1px solid var(--line-2)", borderRadius: 6, padding: 7, font: "inherit" } as const;
const button = { ...input, width: "auto", cursor: "pointer" } as const;
const supported = new Set(["title", "bullets", "definition", "quote", "comparison", "diagram", "chart", "code"]);

/** Sequence in layer order; reject instead of silently placing strokes beyond the shot. */
export function sequenceStrokes(scene: Scene, startMs: number, gapMs: number): Scene {
  if (scene.locked || !supported.has(scene.kind)) throw new Error("当前镜头不可编辑手绘路径。");
  if (!Number.isInteger(startMs) || startMs < 0 || !Number.isInteger(gapMs) || gapMs < 0 || gapMs > 10000) throw new Error("起点和间隔须为非负整数，间隔不超过 10000 毫秒。");
  const strokes = (scene.elements ?? []).filter((element): element is Stroke => element.kind === "path");
  if (strokes.length < 2) throw new Error("至少需要两条路径才能顺序编排。");
  let time = startMs;
  const starts = new Map<string, number>();
  for (const stroke of strokes) {
    starts.set(stroke.id, time);
    time += stroke.drawDurationMs ?? 1500;
    if (stroke !== strokes[strokes.length - 1]) time += gapMs;
  }
  if (time > sceneDurationMs(scene)) throw new Error("编排超出镜头时长，请提前播放头、缩短路径时长或间隔，或延长镜头。");
  return { ...scene, elements: scene.elements!.map(element => element.kind === "path" ? { ...element, drawStartMs: starts.get(element.id)!, drawDurationMs: element.drawDurationMs ?? 1500 } : element) };
}

/** A stroke is authored locally and only added to the scene after confirmation. */
export function StrokePad({ project, scene, timeMs, onChange }: { project: SceneScriptProject; scene: Scene; timeMs: number; onChange(scene: Scene): void | boolean }) {
  const [open, setOpen] = useState(false), [d, setD] = useState(""), [notice, setNotice] = useState("");
  const [color, setColor] = useState("#dbc6a0"), [duration, setDuration] = useState(1500), [gap, setGap] = useState("0");
  const points = useRef<Array<[number, number]>>([]), revision = useRef("");
  const pointer = useRef<number | null>(null);
  const width = project.aspect === "16:9" ? 1920 : 1080, height = project.aspect === "9:16" ? 1920 : 1080;
  const editable = supported.has(scene.kind) && !scene.locked;
  const allowed = editable && (scene.elements?.length ?? 0) < 20;
  const path = () => points.current.map((point, index) => `${index ? "L" : "M"}${point[0]} ${point[1]}`).join(" ");
  const append = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect(); if (!box.width || !box.height) return;
    const point: [number, number] = [Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * width), Math.round(Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) * height)];
    const previous = points.current.at(-1);
    if (points.current.length < 400 && (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) >= 3)) { points.current.push(point); setD(path()); }
  };
  useEffect(() => { if (!allowed) pointer.current = null; }, [allowed]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ minWidth: 0 }}>
    <summary>手绘与逐笔动画</summary>
    {open && <div style={{ display: "grid", gap: 9, marginTop: 10 }}>
      <small>在下面画一笔，再加入镜头。每笔独立设置起点和时长；也可粘贴 M/L/H/V/Q/C/S/T/A/Z 路径（绝对或相对坐标，圆弧 A 会转为平滑曲线）。仅支持内置场景，不导入 SVG 文件。</small>
      <svg aria-label="手绘输入画布" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", maxWidth: Math.round(280 * width / height), aspectRatio: `${width}/${height}`, background: "var(--ink-2)", border: "1px solid var(--line-2)", borderRadius: 8, touchAction: "none", cursor: allowed ? "crosshair" : "not-allowed" }}
        onPointerDown={event => { if (!allowed || pointer.current !== null || !event.isPrimary || event.button !== 0) return; event.preventDefault(); revision.current = canonicalJson(scene); points.current = []; pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); setNotice(""); append(event); }}
        onPointerMove={event => { if (allowed && pointer.current === event.pointerId) append(event); }}
        onPointerUp={event => { if (pointer.current !== event.pointerId) return; append(event); pointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { pointer.current = null; points.current = []; setD(""); setNotice("绘制已取消。"); }}>
        <path d={isStrokePath(d) ? d : ""} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <label>路径数据<textarea aria-label="新路径数据" rows={2} disabled={!allowed} style={input} maxLength={8192} value={d} onChange={event => { if (!d) revision.current = canonicalJson(scene); setD(event.target.value); setNotice(""); }} /></label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label>笔色 <input aria-label="新路径颜色" type="color" style={{ width: 44, height: 32, padding: 3 }} disabled={!allowed} value={color} onChange={event => setColor(event.target.value)} /></label>
        <label>逐笔时长 <input aria-label="新路径绘制时长" style={{ ...input, width: 95 }} type="number" min={100} max={10000} step={100} value={duration} onChange={event => setDuration(Number(event.target.value))} /> ms</label>
        <button type="button" style={button} disabled={!allowed || !isStrokePath(d) || !Number.isInteger(duration) || duration < 100 || duration > 10000} onClick={() => {
          if (revision.current !== canonicalJson(scene)) { setNotice("镜头已变化，请清空后重新绘制，避免加到旧位置。"); return; }
          if (Math.round(timeMs) + duration > sceneDurationMs(scene)) { setNotice("逐笔动画超出镜头时长，请提前播放头、缩短绘制时长或延长镜头；草稿已保留。"); return; }
          const element = SceneElement.parse({ id: `stroke-${crypto.randomUUID().slice(0, 8)}`, kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d, viewBox: [width, height], stroke: color, strokeWidth: 8, drawStartMs: Math.round(timeMs), drawDurationMs: duration });
          if (onChange(addElement(scene, element)) === false) { setNotice("路径尚未加入，请检查工程限制；草稿已保留。"); return; }
          setD(""); points.current = []; setNotice("已加入逐笔路径，可在对象列表选择和调整。");
        }}>加入镜头</button>
        <button type="button" style={button} onClick={() => { pointer.current = null; points.current = []; setD(""); setNotice(""); revision.current = ""; }}>清空手绘</button>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
        <label>笔画间隔（ms）<input aria-label="笔画间隔" style={{ ...input, width: 100 }} type="number" min={0} max={10000} step={100} value={gap} disabled={!editable} onChange={event => setGap(event.target.value)} /></label>
        <button type="button" style={button} disabled={!editable || (scene.elements ?? []).filter(element => element.kind === "path").length < 2} onClick={() => {
          try {
            if (!gap.trim()) throw new Error("请输入笔画间隔。");
            const next = sequenceStrokes(scene, Math.round(timeMs), Number(gap));
            if (onChange(next) === false) { setNotice("编排未应用，请检查工程限制。"); return; }
            setNotice("已按对象顺序编排全部路径，可撤销本次操作。");
          } catch (error) { setNotice(error instanceof Error ? error.message : "编排失败，请重试。"); }
        }}>从播放头顺序绘制</button>
      </div>
      <small>按对象列表顺序排列所有路径；静态路径默认以 1500 ms 绘制，已有逐笔时长保持不变。本操作会覆盖各路径的起笔时间。</small>
      {!supported.has(scene.kind) && <small>此工具仅用于标题、图表等内置场景。</small>}
      {notice && <small role="status">{notice}</small>}
    </div>}
  </details>;
}

export function StrokeSettings({ element, revision, onChange }: { element: Stroke; revision: string; onChange(element: Stroke): boolean }) {
  const [d, setD] = useState(element.d);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { if (draftRevision === null) setD(element.d); }, [element.d, draftRevision]);
  const stale = draftRevision !== null && draftRevision !== revision;
  const discard = () => { setD(element.d); setDraftRevision(null); setNotice(""); };
  return <div style={{ display: "grid", gap: 9 }}>
    <label>路径数据<textarea aria-label="选中路径数据" style={input} rows={3} maxLength={8192} value={d} onChange={event => { setDraftRevision(current => current ?? revision); setD(event.target.value); setNotice(""); }} /></label>
    <div><button type="button" style={button} disabled={stale || d === element.d || !isStrokePath(d)} onClick={() => {
      if (onChange(SceneElement.parse({ ...element, d }) as Stroke)) { setDraftRevision(null); setNotice("路径已应用，可撤销。"); }
      else setNotice("路径未应用，草稿已保留。");
    }}>应用路径数据</button>{draftRevision !== null && <button type="button" style={button} onClick={discard}>放弃路径草稿</button>}</div>
    {stale && <small role="alert">镜头在编辑路径期间已变化；草稿已保留，请复制草稿或放弃后重新编辑。</small>}
    {notice && <small role="status">{notice}</small>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,140px),1fr))", gap: 9 }}>
      <label>路径宽度 {Number((element.w * 100).toFixed(1))}%<input aria-label="路径宽度" type="range" min={0.1} max={100} step={0.1} value={element.w * 100} onChange={event => onChange({ ...element, w: Number(event.target.value) / 100 })} /></label>
      <label>路径高度 {Number((element.h * 100).toFixed(1))}%<input aria-label="路径高度" type="range" min={0.1} max={100} step={0.1} value={element.h * 100} onChange={event => onChange({ ...element, h: Number(event.target.value) / 100 })} /></label>
      <label>笔色 <input aria-label="路径颜色" type="color" style={{ width: 44, height: 32, padding: 3 }} value={element.stroke} onChange={event => onChange({ ...element, stroke: event.target.value })} /></label>
      <label>笔宽 {element.strokeWidth}<input aria-label="路径笔宽" type="range" min={1} max={60} value={element.strokeWidth} onChange={event => onChange({ ...element, strokeWidth: Number(event.target.value) })} /></label>
      <label>起笔（ms）<input aria-label="路径起笔时间" style={input} type="number" min={0} max={86400000} step={100} value={element.drawStartMs ?? 0} onChange={event => { if (!event.target.value.trim()) return; const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= 86400000) onChange({ ...element, drawStartMs: value }); }} /></label>
      <label>绘制（ms）<input aria-label="路径绘制时长" style={input} type="number" min={1} max={86400000} step={100} value={element.drawDurationMs ?? 1500} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value > 0 && value <= 86400000) onChange({ ...element, drawDurationMs: value }); }} /></label>
    </div>
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input aria-label="启用逐笔动画" type="checkbox" style={{ width: 16, height: 16, margin: 0, padding: 0 }} checked={element.drawDurationMs !== undefined} onChange={event => onChange({ ...element, drawDurationMs: event.target.checked ? 1500 : undefined })} />逐笔动画</label>
    <small>宽高为镜头尺寸的百分比，路径在此边界内等比居中，不会拉伸路径；坐标画布 {element.viewBox[0]} × {element.viewBox[1]}。逐笔动画使用镜头本地时间。</small>
  </div>;
}
