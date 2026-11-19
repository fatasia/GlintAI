import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NleClip } from "@glintai/scenescript";
import { addMotionKeyframe, clampMotion, MOTION_FIELDS, MOTION_LABELS, motionCurvePoints, motionFrameMs, motionPathPoints, moveMotionKeyframe, patchMotionKeyframe, removeMotionField, removeMotionKeyframe, sampleMotion, stepMotionFrameMs, type MotionField } from "./nle-motion";
import { useMotionGesture, type NleMotionEditorProps } from "./nle-motion-gesture";
import "./nle-motion.css";

export type { NleMotionEditorProps } from "./nle-motion-gesture";

function MotionNumber({ value, label, min, max, step, disabled, onCommit }: { value: number; label: string; min: number; max: number; step: number; disabled: boolean; onCommit(value: number): void }) {
  const [text, setText] = useState(String(value));
  const cancelBlur = useRef(false);
  useEffect(() => setText(String(Number(value.toFixed(4)))), [value]);
  const commit = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    const next = text.trim() === "" ? NaN : Number(text);
    if (!Number.isFinite(next) || next < min || next > max) { setText(String(value)); return; }
    if (next !== value) onCommit(next);
  };
  return <input aria-label={label} type="number" min={min} max={max} step={step} value={text} disabled={disabled}
    onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { cancelBlur.current = true; setText(String(value)); event.currentTarget.blur(); }
    }} />;
}

/** Edits only the existing clip-local keyframe contract; the host owns history and persistence. */
export function NleMotionEditor(props: NleMotionEditorProps) {
  const { clip, fps, playheadMs, locked = false } = props;
  const ui = useMotionGesture(props);
  const [field, setField] = useState<MotionField>("x");
  const panel = useRef<HTMLElement>(null), focusAfterEdit = useRef<"time" | "path" | null>(null);
  useEffect(() => {
    if (!focusAfterEdit.current || ui.selected === null) return;
    const point = panel.current?.querySelector<SVGElement>(`[data-motion-surface="${focusAfterEdit.current}"] [data-motion-ms="${ui.selected}"]`);
    if (point) { point.focus(); focusAfterEdit.current = null; }
  }, [clip, ui.selected]);
  const shown = ui.draft ?? clip, frames = shown.keyframes ?? [];
  const selected = frames.find(frame => frame.ms === ui.selected);
  const localMs = clampMotion(playheadMs - clip.startMs, 0, clip.durationMs);
  const motion = sampleMotion(shown, selected?.ms ?? localMs), playMotion = sampleMotion(shown, localMs);
  const validFps = Number.isFinite(fps) && fps >= 1 && fps <= 120;
  const readonly = locked || clip.kind === "audio" || !validFps;
  const busy = ui.recording || Boolean(ui.draft);
  const blocked = readonly || busy;
  const position = (ms: number) => 12 + ms / clip.durationMs * 276;
  const format = (ms: number) => `${(ms / 1000).toFixed(3)} 秒`;
  const reason = locked ? "片段已锁定，仅可定位播放头。" : clip.kind === "audio" ? "音频片段不显示画面动效。" : !validFps ? "帧率须为 1–120，请检查工程设置。" : "";
  const change = (operation: () => NleClip, ms?: number) => { if (!blocked) ui.apply(operation, ms); };
  const remove = () => { if (selected) change(() => removeMotionKeyframe(clip, selected.ms)); };
  const moveSelected = (ms: number) => {
    if (!selected) return;
    const next = motionFrameMs(ms, clip.durationMs, fps);
    change(() => moveMotionKeyframe(clip, selected.ms, next, fps), next);
  };
  const pointKey = (event: KeyboardEvent<SVGElement>, ms: number, surface: "time" | "path") => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); ui.cancel(); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ui.choose(ms); return; }
    if (blocked) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); change(() => removeMotionKeyframe(clip, ms)); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    if (surface === "time") {
      const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
      const next = stepMotionFrameMs(ms, direction, clip.durationMs, fps);
      focusAfterEdit.current = "time";
      change(() => moveMotionKeyframe(clip, ms, next, fps), next);
    } else {
      const value = sampleMotion(clip, ms), horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const key = horizontal ? "x" : "y", direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      change(() => patchMotionKeyframe(clip, ms, { [key]: Number(clampMotion(value[key] + direction * (event.shiftKey ? 0.1 : 0.01), -1, 1).toFixed(4)) }));
    }
  };
  const handlers = (surface: "time" | "path") => ({
    onPointerDown: (event: Parameters<typeof ui.start>[0]) => { if (!readonly) ui.start(event, surface); else if (surface === "time") { const frame = (event.target as Element).closest("[data-motion-ms]"); if (frame) ui.choose(Number(frame.getAttribute("data-motion-ms"))); } },
    onPointerMove: ui.move, onPointerUp: ui.finish, onPointerCancel: ui.cancel,
    onLostPointerCapture: () => { if (ui.dragging()) ui.cancel(); },
  });
  const pointClick = (ms: number) => { if (!ui.recording) ui.choose(ms); };
  return <section ref={panel} className="nle-motion" data-readonly={readonly} aria-label="片段动效编辑器" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); ui.cancel(); }
  }}>
    <header className="nle-motion-head"><div><strong>关键帧动效</strong><small>片段内时间 · {frames.length}/32 点</small></div><span className="nle-motion-badge">{locked ? "只读" : ui.recording ? "录制待命" : "原生关键帧"}</span></header>
    <p className="nle-motion-caption" title={clip.kind === "text" ? clip.text : clip.src}>{clip.kind === "text" ? clip.text : clip.src}</p>
    {reason && <p className="nle-motion-notice">{reason}</p>}
    <div className="nle-motion-toolbar">
      <button type="button" className="nle-motion-primary" disabled={blocked || (frames.length >= 32 && !frames.some(frame => frame.ms === motionFrameMs(localMs, clip.durationMs, fps)))} title={blocked ? reason || "请先完成或取消当前手势" : frames.length >= 32 ? "最多 32 点；同一时间可更新" : "在播放头处按帧网格添加"} onClick={() => { const ms = motionFrameMs(localMs, clip.durationMs, fps); change(() => addMotionKeyframe(clip, ms, fps), ms); }}>添加当前帧</button>
      <button type="button" disabled={blocked || !selected} title={selected ? "删除所选关键帧（Delete）" : "请先选择一个关键帧"} onClick={remove}>删除所选</button>
      <span className="nle-motion-time">播放头 {format(localMs)}</span>
    </div>
    <svg className="nle-motion-timeline" data-motion-surface="time" viewBox="0 0 300 64" preserveAspectRatio="none" role="group" aria-label="关键帧时间轴" {...handlers("time")}>
      <line x1="12" y1="32" x2="288" y2="32" className="nle-motion-grid" />
      {[0, 0.25, 0.5, 0.75, 1].map(t => <line key={t} x1={12 + 276 * t} x2={12 + 276 * t} y1="24" y2="40" className="nle-motion-grid" />)}
      <line x1={position(localMs)} x2={position(localMs)} y1="5" y2="59" className="nle-motion-playhead" />
      {frames.map(frame => <g key={frame.ms} data-motion-ms={frame.ms} role="button" tabIndex={0} aria-label={`时间点 ${frame.ms} 毫秒`} aria-pressed={selected?.ms === frame.ms} onClick={() => pointClick(frame.ms)} onKeyDown={event => pointKey(event, frame.ms, "time")}>
        <title>{format(frame.ms)} · 拖动重定时，方向键逐帧移动，Delete 删除</title>
        <rect x={position(frame.ms) - 10} y="12" width="20" height="40" className="nle-motion-hit" />
        <path d={`M ${position(frame.ms)} 24 l 7 8 -7 8 -7 -8 Z`} className="nle-motion-point" />
      </g>)}
    </svg>
    <div className="nle-motion-scale"><span>0 秒</span><span>{format(clip.durationMs)}</span></div>
    {!frames.length && <p className="nle-motion-empty">尚无关键帧。在播放头添加一个点，或录制拖动手势生成路径。</p>}
    <label className="nle-motion-scrub">定位播放头<input aria-label="定位播放头" type="range" min={0} max={clip.durationMs} step={1} value={localMs} onChange={event => ui.seek(validFps ? motionFrameMs(Number(event.target.value), clip.durationMs, fps) : Number(event.target.value))} /></label>
    <div className="nle-motion-selection">
      <strong>{selected ? `所选点 · ${format(selected.ms)}` : "请选择时间轴上的点"}</strong>
      {selected && <label>时间（毫秒）<MotionNumber key={`time-${selected.ms}`} value={selected.ms} label="关键帧时间" min={0} max={clip.durationMs} step={validFps ? 1000 / fps : 1} disabled={blocked} onCommit={moveSelected} /></label>}
    </div>
    <div className="nle-motion-fields">{MOTION_FIELDS.map(key => {
      const meta = MOTION_LABELS[key], enabled = selected?.[key] !== undefined;
      return <div className="nle-motion-field" key={key}>
        <label title="勾选后为此属性写入关键帧；取消后沿用其他点或静态值"><input type="checkbox" aria-label={`动画${meta.label}`} checked={enabled} disabled={blocked || !selected} onChange={event => { if (selected) change(() => event.target.checked ? patchMotionKeyframe(clip, selected.ms, { [key]: motion[key] }) : removeMotionField(clip, selected.ms, key)); }} />{meta.label}<small>{meta.unit}</small></label>
        <MotionNumber key={`${clip.id}-${selected?.ms}-${key}`} value={selected?.[key] ?? motion[key]} label={`${meta.label}值`} min={meta.min} max={meta.max} step={meta.step} disabled={blocked || !selected} onCommit={value => { if (selected) change(() => patchMotionKeyframe(clip, selected.ms, { [key]: value })); }} />
      </div>;
    })}</div>
    <div className="nle-motion-curve-controls">
      <label>离开此点的缓动<select aria-label="关键帧缓动" value={selected?.ease ?? "linear"} disabled={blocked || !selected} onChange={event => { if (selected) change(() => patchMotionKeyframe(clip, selected.ms, { ease: event.target.value as "linear" | "in" | "out" })); }}><option value="linear">线性</option><option value="in">缓入（二次）</option><option value="out">缓出（三次）</option></select></label>
      <label>曲线属性<select aria-label="曲线属性" value={field} onChange={event => setField(event.target.value as MotionField)}>{MOTION_FIELDS.map(key => <option key={key} value={key}>{MOTION_LABELS[key].label}</option>)}</select></label>
    </div>
    <svg className="nle-motion-curve" viewBox="0 0 300 120" preserveAspectRatio="none" role="img" aria-label={`${MOTION_LABELS[field].label}真实求值曲线`}>
      <title>全片段实际属性曲线；纵轴按当前值域适配，不是通用缓动示意图</title>
      {[8, 60, 112].map(y => <line key={y} x1="8" x2="292" y1={y} y2={y} className="nle-motion-grid" />)}
      <polyline points={motionCurvePoints(shown, field)} className="nle-motion-line" />
      <line x1={8 + localMs / clip.durationMs * 284} x2={8 + localMs / clip.durationMs * 284} y1="8" y2="112" className="nle-motion-playhead" />
    </svg>
    <p className="nle-motion-caption">真实求值预览 · {MOTION_LABELS[field].label} · 当前 {Number(playMotion[field].toFixed(3))} {MOTION_LABELS[field].unit}。缺省属性由静态值或其他关键帧决定。</p>
    <div className="nle-motion-toolbar"><strong>画面路径</strong><button type="button" aria-pressed={ui.recording} disabled={readonly || Boolean(ui.draft)} title={reason || "将一次拖动映射到整个片段时长，最多 32 点；保留其他属性和既有时间点"} onClick={() => { if (ui.recording) ui.cancel(); else { ui.setRecording(true); ui.setMessage("录制待命：在下方画布按住拖动，松开写入；Esc 取消。 "); } }}>{ui.recording ? "取消录制" : "录制拖动手势"}</button></div>
    <svg className="nle-motion-path" data-motion-surface="path" data-recording={ui.recording} viewBox="0 0 300 180" preserveAspectRatio="none" role="group" aria-label="画面路径画布" {...handlers("path")}>
      <rect x="20" y="20" width="260" height="140" className="nle-motion-boundary" />
      <line x1="150" x2="150" y1="20" y2="160" className="nle-motion-grid" /><line x1="20" x2="280" y1="90" y2="90" className="nle-motion-grid" />
      <polyline points={motionPathPoints(shown)} className="nle-motion-line" />
      {frames.map(frame => {
        const value = sampleMotion(shown, frame.ms);
        return <circle key={frame.ms} data-motion-ms={frame.ms} cx={150 + value.x * 130} cy={90 + value.y * 70} r="7" role="button" tabIndex={0} aria-label={`路径点 ${frame.ms} 毫秒`} aria-pressed={selected?.ms === frame.ms} className="nle-motion-point" onClick={() => pointClick(frame.ms)} onKeyDown={event => pointKey(event, frame.ms, "path")}><title>{format(frame.ms)} · x {value.x.toFixed(2)} / y {value.y.toFixed(2)} · 拖动或方向键编辑</title></circle>;
      })}
      <circle cx={150 + playMotion.x * 130} cy={90 + playMotion.y * 70} r="4" className="nle-motion-cursor" />
      <text x="24" y="174">−1</text><text x="143" y="174">0</text><text x="266" y="174">+1</text>
    </svg>
    <p className="nle-motion-caption">x 向右、y 向下，范围 −1 至 +1 画幅；路径为归一化坐标示意，不叠加素材。拖点改位置，方向键微调；时间轴方向键重定时，Delete 删除，Esc 取消。</p>
    <p className="nle-motion-caption">录制将整次手势映射到片段帧网格，再按插值误差简化至 32 点；合并会替换 x/y，保留已有非位置属性及缓动。复杂轨迹或满点时会损失细节。</p>
    <p className="nle-motion-feedback" role="status" aria-live="polite">{ui.message || (ui.recording ? "在路径画布按住拖动开始录制。" : "修改随工程保存，拖动释放时提交一次。")}</p>
  </section>;
}
