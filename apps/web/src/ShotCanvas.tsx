import { useEffect, useMemo, useRef, useState } from "react";
import { BRUSH_PATHS, evaluateElements, evaluateMorphElements, parseProject, strokePathAt, strokeProgress, sceneDurationMs, type AnimationProperty, type Scene, type SceneScriptProject } from "@glintai/scenescript";
import { StrokePad, StrokeSettings } from "./StrokeTools";
import { resolveTheme } from "@glintai/design-tokens";
import { canonicalJson } from "@glintai/session";
import { addElement, findElement, findTrack, keyframeTimes, moveElement, moveKeyframeByFrame, moveKeyframeToTime, removeElement, removeKeyframe, setElementAnimated, setElementText, setKeyframeEasing, setRectAppearance, setRectProperty, upsertKeyframe } from "./shot-model";

/**
 * Shot canvas: direct manipulation of the editable object layer.
 *
 * The background here is a theme-coloured stage, not the rendered frame — final
 * pixels come from the renderer. Objects, positions, opacity and keyframes are
 * the real contract and round-trip through `onChange` into the shared session.
 */

const panel = { display: "grid", gap: 10, padding: 12, minWidth: 0, border: "1px solid var(--ink-4)", borderRadius: 10, background: "var(--ink-1)" } as const;
const button = { background: "var(--ink-3)", border: "1px solid var(--line-2)", color: "var(--paper)", padding: "6px 10px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 12 } as const;
const input = { width: "100%", minWidth: 0, padding: 6, borderRadius: 6, border: "1px solid var(--line-2)", color: "var(--paper)", background: "var(--ink-2)", font: "inherit" } as const;
const FRAME_EDIT_SCENES: ReadonlySet<Scene["kind"]> = new Set(["title", "bullets", "definition", "quote", "comparison", "diagram", "chart", "code"]);

function KeyframeTimeEditor({ property, time, duration, revision, apply }: { property: AnimationProperty; time: number; duration: number; revision: string; apply(value: string, revision: string): void }) {
  const [value, setValue] = useState(String(time));
  const editedRevision = useRef<string | null>(null);
  return <form style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} onSubmit={event => { event.preventDefault(); apply(value, editedRevision.current ?? revision); }}>
    <label>时间（ms）<input aria-label={`${property} 关键帧时间`} type="number" min={0} max={duration} step={1} style={{ ...input, width: 100 }} value={value} onChange={event => { editedRevision.current ??= revision; setValue(event.target.value); }} /></label>
    <button type="submit" style={button}>移动到时间</button>
  </form>;
}

export interface ShotCanvasProps {
  project: SceneScriptProject;
  scene: Scene;
  onChange(scene: Scene): void;
  onSeek?(sceneId: string, timeMs: number): void;
}

export function ShotCanvas({ project, scene, onChange, onSeek }: ShotCanvasProps) {
  const theme = resolveTheme(project.theme);
  const duration = Math.max(1, sceneDurationMs(scene));
  const [playheadMs, setPlayheadMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(scene.elements?.[0]?.id);
  const [draft, setDraft] = useState<Scene | null>(null);
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; x: number; y: number; revision: string } | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { setPlayheadMs(0); setSelectedId(scene.elements?.[0]?.id); setDraft(null); setDrag(null); }, [scene.id]);
  useEffect(() => { if (scene.locked) { setDraft(null); setDrag(null); } }, [scene.locked]);
  useEffect(() => { if (drag && canonicalJson(scene) !== drag.revision) { setDraft(null); setDrag(null); setNotice("镜头在拖动期间已变化，本次拖动未应用。"); } }, [scene, drag]);
  const canvas = useRef<HTMLDivElement | null>(null);
  const active = draft ?? scene;
  const sceneIndex = project.scenes.findIndex(item => item.id === scene.id);
  const previous = sceneIndex > 0 ? project.scenes[sceneIndex - 1] : undefined;
  const morphing = active.transition?.in === "shape-morph" && Boolean(previous) && playheadMs < (active.transition.durationMs ?? 800);
  const morphIds = useMemo(() => new Set(morphing ? (previous?.elements ?? []).filter(item => item.kind === "rect" || item.kind === "path").map(item => item.id) : []), [morphing, previous]);
  const states = useMemo(() => evaluateElements(active, playheadMs), [active, playheadMs]);
  const displayStates = useMemo(() => active.transition?.in === "shape-morph" && previous ? evaluateMorphElements(active, previous, playheadMs) : states, [active, previous, playheadMs, states]);
  useEffect(() => { if (drag && morphIds.has(drag.id)) { setDraft(null); setDrag(null); setNotice("已进入形变预览，本次拖动未应用。"); } }, [drag, morphIds]);
  const selected = selectedId ? findElement(active, selectedId) : undefined;
  const selectedState = selected ? states.find(state => state.element.id === selected.id) : undefined;
  const commit = (next: Scene): boolean => {
    if (scene.locked) return false;
    const candidate = { ...project, scenes: project.scenes.map(item => item.id === scene.id ? next : item) };
    if (JSON.stringify(candidate).length > 100_000) { setNotice("工程超过 Web 编辑器的 100000 字符上限，本次修改未加入；请简化路径或拆分章节。"); return false; }
    try { parseProject(candidate); } catch { setDraft(null); setNotice("修改与现有形变或工程约束冲突，未应用。请先移除形变或检查路径、逐笔动画与关键帧。"); return false; }
    setDraft(null); onChange(next); return true;
  };
  const patch = commit;
  const seek = (timeMs: number) => {
    setPlayheadMs(timeMs);
    onSeek?.(scene.id, timeMs);
  };
  const nudgeKeyframe = (elementId: string, property: AnimationProperty, direction: -1 | 1) => {
    if (scene.locked) return;
    try {
      const result = moveKeyframeByFrame(active, elementId, property, playheadMs, direction, project.fps ?? 30, duration);
      if (commit(result.scene)) {
        seek(result.atMs);
        setNotice(`关键帧已移动至 ${(result.atMs / 1000).toFixed(3)} 秒。`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "关键帧移动失败，请重试。");
    }
  };

  const onPointerDown = (event: React.PointerEvent, elementId: string, position: { x: number; y: number }) => {
    if (scene.locked) return;
    setSelectedId(elementId);
    if (morphIds.has(elementId)) { setNotice("形变预览期间不能拖动匹配对象；请将播放头移至形变结束后编辑目标位置。"); return; }
    setNotice(""); setDrag({ id: elementId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, revision: canonicalJson(scene) });
    canvas.current?.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const x = drag.x + (event.clientX - drag.startX) / rect.width;
    const y = drag.y + (event.clientY - drag.startY) / rect.height;
    setDraft(moveElement(active, drag.id, { x, y }, playheadMs));
  };
  const endDrag = () => {
    if (drag && draft && canonicalJson(scene) === drag.revision) commit(draft);
    setDrag(null);
  };
  const cancelDrag = () => { setDraft(null); setDrag(null); };

  const addText = () => {
    const id = `el-${crypto.randomUUID().slice(0, 6)}`;
    commit(addElement(scene, { id, kind: "text", text: "新文字", x: 0.5, y: 0.5, fontSize: 56 }));
    setSelectedId(id);
  };
  const addRect = () => {
    const id = `el-${crypto.randomUUID().slice(0, 6)}`;
    commit(addElement(scene, { id, kind: "rect", x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: "#4f8cff", radius: 8 }));
    setSelectedId(id);
  };

  const tracksForSelected: Array<{ property: AnimationProperty; times: number[] }> = selected
    ? (["x", "y", "opacity", "scale", "rotate"] as AnimationProperty[]).map(property => ({ property, times: keyframeTimes(active, selected.id, property) })).filter(entry => entry.times.length > 0)
    : [];

  return (
    <section style={panel} aria-label="对象与关键帧">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ marginRight: "auto" }}>对象与关键帧</strong>
        <button type="button" style={button} disabled={scene.locked || (active.elements?.length ?? 0) >= 20} onClick={addText}>添加文字对象</button>
        <button type="button" style={button} disabled={scene.locked || (active.elements?.length ?? 0) >= 20} onClick={addRect}>添加色块对象</button>
      </div>

      <div
        ref={canvas}
        role="application"
        aria-label="镜头画布"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: project.aspect.replace(":", " / "),
          maxHeight: 360,
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid var(--line-2)",
          background: theme.colors.bg,
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {displayStates.map(state => {
          const isSelected = state.element.id === selectedId;
          const outline = isSelected ? "1px dashed #a8cdf7" : "1px dashed transparent";
          return state.element.kind === "text" ? (
            <div
              key={state.element.id}
              role="button"
              aria-label={`对象 ${state.element.id}`}
              tabIndex={0}
              onPointerDown={event => onPointerDown(event, state.element.id, { x: state.x, y: state.y })}
              style={{
                position: "absolute", left: `${state.x * 100}%`, top: `${state.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${state.rotate}deg) scale(${state.scale})`, opacity: state.opacity,
                color: state.element.color ?? theme.colors.text, fontSize: state.element.fontSize ?? 48,
                fontWeight: state.element.weight ?? 700, textAlign: state.element.align ?? "center",
                whiteSpace: "pre-wrap", lineHeight: 1.15, outline, cursor: "grab", padding: 2,
              }}
            >
              {state.element.text}
            </div>
          ) : state.element.kind === "path" ? <svg key={state.element.id} role="button" aria-label={`对象 ${state.element.id}`} tabIndex={0} onPointerDown={event => onPointerDown(event, state.element.id, { x: state.x, y: state.y })} viewBox={`0 0 ${state.element.viewBox.join(" ")}`} preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", left: `${state.x * 100}%`, top: `${state.y * 100}%`, width: `${state.element.w * 100}%`, height: `${state.element.h * 100}%`, transform: `translate(-50%, -50%) rotate(${state.rotate}deg) scale(${state.scale})`, opacity: state.opacity, outline, cursor: "grab", pointerEvents: "none" }}><path d={active.transition?.in === "shape-morph" && previous?.elements?.some(source => source.id === state.element.id && source.kind === "path") ? state.element.d : strokePathAt(state.element.d, strokeProgress(state.element, playheadMs))} fill="none" stroke={state.element.stroke} strokeWidth={state.element.strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "stroke" }} /></svg> : (
            <div
              key={state.element.id}
              role="button"
              aria-label={`对象 ${state.element.id}`}
              tabIndex={0}
              onPointerDown={event => onPointerDown(event, state.element.id, { x: state.x, y: state.y })}
              style={{
                position: "absolute", left: `${state.x * 100}%`, top: `${state.y * 100}%`,
                width: `${state.element.w * 100}%`, height: `${state.element.h * 100}%`,
                transform: `translate(-50%, -50%) rotate(${state.rotate}deg) scale(${state.scale})`, opacity: state.opacity,
                background: state.element.appearance === "brush" ? "transparent" : state.element.fill,
                borderRadius: state.element.appearance === "brush" ? 0 : state.element.radius ?? 0, outline, cursor: "grab",
              }}
            >{state.element.appearance === "brush" && <svg aria-hidden="true" viewBox="0 0 1000 100" preserveAspectRatio="none" width="100%" height="100%">{BRUSH_PATHS.map(path => <path key={path.d} d={path.d} fill={state.element.kind === "rect" ? state.element.fill : "transparent"} opacity={path.opacity} />)}</svg>}</div>
          );
        })}
      </div>

      {morphing && <small>正在预览形变；属性面板编辑的是目标状态。形变结束后可拖动匹配对象。</small>}
      <label style={{ display: "grid", gap: 4 }}>
        播放头 {(playheadMs / 1000).toFixed(2)}s
        <input aria-label="播放头" type="range" min={0} max={duration} step={10} value={Math.min(playheadMs, duration)} onChange={event => seek(Number(event.target.value))} />
      </label>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(active.elements ?? []).map(element => (
          <button key={element.id} type="button" style={{ ...button, borderColor: element.id === selectedId ? "#7c8cff" : "var(--line-2)" }} onClick={() => setSelectedId(element.id)}>
            {element.kind === "text" ? element.text.slice(0, 12) : element.id}
          </button>
        ))}
        {selected && <button type="button" style={button} disabled={scene.locked} onClick={() => { commit(removeElement(active, selected.id)); setSelectedId(undefined); }}>删除选中对象</button>}
      </div>

      {selected && (
        <fieldset disabled={scene.locked} style={{ display: "grid", gap: 8, padding: 0, margin: 0, border: 0, minWidth: 0 }}>
          {selected.kind === "text" && (
            <label>文字内容
              <input aria-label="文字内容" style={input} value={selected.text} onChange={event => patch(setElementText(active, selected.id, event.target.value))} />
            </label>
          )}
          {selected.kind === "rect" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,120px),1fr))", gap: 8 }}>
            <label>形态<select aria-label="色块形态" style={input} value={selected.appearance ?? "solid"} onChange={event => patch(setRectAppearance(active, selected.id, event.target.value as "solid" | "brush"))}><option value="solid">实色色块</option><option value="brush" disabled={! ["title", "bullets", "definition", "quote", "comparison", "diagram", "chart", "code"].includes(active.kind)}>矢量笔触（内置场景）</option></select></label>
            <label style={{ minWidth: 0 }}>宽度 {Math.round(selected.w * 100)}%<input aria-label="色块宽度" type="range" style={{ width: "100%", margin: 0 }} min={1} max={100} step={1} value={selected.w * 100} onChange={event => patch(setRectProperty(active, selected.id, "w", Number(event.target.value) / 100))} /></label>
            <label style={{ minWidth: 0 }}>高度 {Math.round(selected.h * 100)}%<input aria-label="色块高度" type="range" style={{ width: "100%", margin: 0 }} min={1} max={100} step={1} value={selected.h * 100} onChange={event => patch(setRectProperty(active, selected.id, "h", Number(event.target.value) / 100))} /></label>
            <label style={{ minWidth: 0 }}>圆角<input disabled={selected.appearance === "brush"} aria-label="色块圆角" type="range" style={{ width: "100%", margin: 0 }} min={0} max={64} step={1} value={selected.radius ?? 0} onChange={event => patch(setRectProperty(active, selected.id, "radius", Number(event.target.value)))} /></label>
            <label>颜色<input aria-label="色块颜色" type="color" value={selected.fill} onChange={event => patch(setRectProperty(active, selected.id, "fill", event.target.value))} /></label>
          </div>}
          {selected.kind === "path" && <StrokeSettings key={`${scene.id}:${selected.id}`} element={selected} revision={canonicalJson(scene)} onChange={element => patch({ ...active, elements: (active.elements ?? []).map(item => item.id === element.id ? element : item) })} />}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["x", "y", "opacity", "scale", "rotate"] as AnimationProperty[]).map(property => (
              <button key={property} type="button" style={button} onClick={() => patch(upsertKeyframe(active, selected.id, property, playheadMs, selectedState?.[property] ?? (property === "opacity" || property === "scale" ? 1 : 0)))}>
                在 {(playheadMs / 1000).toFixed(2)}s 加 {property} 关键帧
              </button>
            ))}
          </div>
          {(["x", "y"] as const).map(property => <label key={property} style={{ display: "grid", gap: 4, minWidth: 0 }}>
            {property === "x" ? "水平位置" : "垂直位置"} {Math.round((selectedState?.[property] ?? 0.5) * 100)}%
            <input aria-label={property === "x" ? "水平位置" : "垂直位置"} type="range" style={{ width: "100%", margin: 0 }} min={0} max={100} step={1} value={(selectedState?.[property] ?? 0.5) * 100} onChange={event => patch(setElementAnimated(active, selected.id, property, playheadMs, Number(event.target.value) / 100))} />
          </label>)}
          <small style={{ color: "var(--muted)" }}>位置已有关键帧时，调整会写入当前播放头；没有关键帧时调整对象的基础位置。</small>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            透明度
            <input aria-label="透明度" type="range" min={0} max={1} step={0.05} value={selectedState?.opacity ?? 1} onChange={event => patch(setElementAnimated(active, selected.id, "opacity", playheadMs, Number(event.target.value)))} />
          </label>
          <label style={{ display: "grid", gap: 4, minWidth: 0 }}>缩放 {(selectedState?.scale ?? 1).toFixed(2)}×<input aria-label="对象缩放" type="range" style={{ width: "100%", margin: 0 }} min={0.1} max={3} step={0.05} value={selectedState?.scale ?? 1} onChange={event => patch(setElementAnimated(active, selected.id, "scale", playheadMs, Number(event.target.value)))} /></label>
          <label style={{ display: "grid", gap: 4, minWidth: 0 }}>旋转 {Math.round(selectedState?.rotate ?? 0)}°<input aria-label="对象旋转" type="range" style={{ width: "100%", margin: 0 }} min={-180} max={180} step={1} value={selectedState?.rotate ?? 0} onChange={event => patch(setElementAnimated(active, selected.id, "rotate", playheadMs, Number(event.target.value)))} /></label>
          {tracksForSelected.map(track => (
            <div key={track.property} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ minWidth: 56 }}>{track.property}</span>
              {track.times.map(time => (
                <button key={time} type="button" style={{ ...button, padding: "2px 6px" }} onClick={() => seek(time)} title={`跳到 ${(time / 1000).toFixed(2)}s`}>
                  {(time / 1000).toFixed(2)}s
                </button>
              ))}
              {FRAME_EDIT_SCENES.has(active.kind) && findTrack(active, selected.id, track.property)?.keyframes.some(key => key.atMs === playheadMs) && <>
                <button type="button" style={button} aria-label={`${track.property} 关键帧前移一帧`} onClick={() => nudgeKeyframe(selected.id, track.property, -1)}>前移一帧</button>
                <button type="button" style={button} aria-label={`${track.property} 关键帧后移一帧`} onClick={() => nudgeKeyframe(selected.id, track.property, 1)}>后移一帧</button>
                <KeyframeTimeEditor key={`${selected.id}:${track.property}:${playheadMs}`} property={track.property} time={playheadMs} duration={duration} revision={canonicalJson(scene)} apply={(value, revision) => {
                  if (scene.locked) return;
                  if (revision !== canonicalJson(scene)) { setNotice("镜头在编辑时间期间已变化；请重新选择关键帧后再试。"); return; }
                  try {
                    const target = value.trim() ? Number(value) : NaN;
                    const next = moveKeyframeToTime(active, selected.id, track.property, playheadMs, target, duration);
                    if (next === active) { setNotice("关键帧已在该时间。"); return; }
                    if (commit(next)) { seek(target); setNotice(`关键帧已移动至 ${(target / 1000).toFixed(3)} 秒。`); }
                  } catch (error) { setNotice(error instanceof Error ? error.message : "关键帧移动失败，请重试。"); }
                }} />
              </>}
              <button type="button" style={button} disabled={!track.times.includes(playheadMs)} onClick={() => patch(removeKeyframe(active, selected.id, track.property, playheadMs))}>删除此处关键帧</button>
              {findTrack(active, selected.id, track.property)?.keyframes.some(key => key.atMs === playheadMs) && <label>到此帧缓动<select aria-label={`${track.property} 关键帧缓动`} style={{ ...input, width: "auto" }} value={(() => { const easing = findTrack(active, selected.id, track.property)?.keyframes.find(key => key.atMs === playheadMs)?.easing; return typeof easing === "object" ? "custom" : easing ?? "linear"; })()} onChange={event => patch(setKeyframeEasing(active, selected.id, track.property, playheadMs, event.target.value as "linear" | "ease-in" | "ease-out" | "ease-in-out"))}>
                <option value="linear">线性</option><option value="ease-in">缓入</option><option value="ease-out">缓出</option><option value="ease-in-out">缓入缓出</option>
                {typeof findTrack(active, selected.id, track.property)?.keyframes.find(key => key.atMs === playheadMs)?.easing === "object" && <option value="custom" disabled>自定义贝塞尔</option>}
              </select></label>}
            </div>
          ))}
        </fieldset>
      )}
      {scene.locked && <small>当前镜头已锁定，对象与关键帧不可修改。</small>}
      {notice && <small role="status">{notice}</small>}
      <StrokePad key={scene.id} project={project} scene={scene} timeMs={playheadMs} onChange={next => { const applied = commit(next); if (applied && (next.elements?.length ?? 0) > (scene.elements?.length ?? 0)) setSelectedId(next.elements?.at(-1)?.id); return applied; }} />
      {!active.elements?.length && <p style={{ color: "var(--muted)", margin: 0 }}>这一镜还没有对象。添加文字或色块后可直接拖动，并在播放头处打关键帧。</p>}
    </section>
  );
}
