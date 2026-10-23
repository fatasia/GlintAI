import { useMemo, useRef, useState } from "react";
import { evaluateElements, sceneDurationMs, type AnimationProperty, type Scene, type SceneScriptProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { addElement, findElement, keyframeTimes, moveElement, removeElement, removeKeyframe, setElementAnimated, setElementText, upsertKeyframe } from "./shot-model";

/**
 * Shot canvas: direct manipulation of the editable object layer.
 *
 * The background here is a theme-coloured stage, not the rendered frame — final
 * pixels come from the renderer. Objects, positions, opacity and keyframes are
 * the real contract and round-trip through `onChange` into the shared session.
 */

const panel = { display: "grid", gap: 10, padding: 12, border: "1px solid #26262b", borderRadius: 10, background: "#0d0d10" } as const;
const button = { background: "#1c1c21", border: "1px solid #2b2b31", color: "#e4e4e7", padding: "6px 10px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 12 } as const;
const input = { width: "100%", minWidth: 0, padding: 6, borderRadius: 6, border: "1px solid #2b2b31", color: "#f4f4f5", background: "#151518", font: "inherit" } as const;

export interface ShotCanvasProps {
  project: SceneScriptProject;
  scene: Scene;
  onChange(scene: Scene): void;
}

export function ShotCanvas({ project, scene, onChange }: ShotCanvasProps) {
  const theme = resolveTheme(project.theme);
  const duration = Math.max(1, sceneDurationMs(scene));
  const [playheadMs, setPlayheadMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(scene.elements?.[0]?.id);
  const [draft, setDraft] = useState<Scene | null>(null);
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const active = draft ?? scene;
  const states = useMemo(() => evaluateElements(active, playheadMs), [active, playheadMs]);
  const selected = selectedId ? findElement(active, selectedId) : undefined;
  const commit = (next: Scene) => { setDraft(null); onChange(next); };
  const patch = (next: Scene) => { setDraft(next); onChange(next); };

  const onPointerDown = (event: React.PointerEvent, elementId: string, position: { x: number; y: number }) => {
    setSelectedId(elementId);
    setDrag({ id: elementId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y });
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
    if (drag && draft) commit(draft);
    setDrag(null);
  };

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
        <button type="button" style={button} onClick={addText}>添加文字对象</button>
        <button type="button" style={button} onClick={addRect}>添加色块对象</button>
      </div>

      <div
        ref={canvas}
        role="application"
        aria-label="镜头画布"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: project.aspect.replace(":", " / "),
          maxHeight: 360,
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid #2b2b31",
          background: theme.colors.bg,
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {states.map(state => {
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
          ) : (
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
                background: state.element.fill, borderRadius: state.element.radius ?? 0, outline, cursor: "grab",
              }}
            />
          );
        })}
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        播放头 {(playheadMs / 1000).toFixed(2)}s
        <input aria-label="播放头" type="range" min={0} max={duration} step={10} value={Math.min(playheadMs, duration)} onChange={event => setPlayheadMs(Number(event.target.value))} />
      </label>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(active.elements ?? []).map(element => (
          <button key={element.id} type="button" style={{ ...button, borderColor: element.id === selectedId ? "#7c8cff" : "#2b2b31" }} onClick={() => setSelectedId(element.id)}>
            {element.kind === "text" ? element.text.slice(0, 12) : element.id}
          </button>
        ))}
        {selected && <button type="button" style={button} onClick={() => { commit(removeElement(active, selected.id)); setSelectedId(undefined); }}>删除选中对象</button>}
      </div>

      {selected && (
        <div style={{ display: "grid", gap: 8 }}>
          {selected.kind === "text" && (
            <label>文字内容
              <input aria-label="文字内容" style={input} value={selected.text} onChange={event => patch(setElementText(active, selected.id, event.target.value))} />
            </label>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["x", "y", "opacity", "scale", "rotate"] as AnimationProperty[]).map(property => (
              <button key={property} type="button" style={button} onClick={() => patch(upsertKeyframe(active, selected.id, property, playheadMs, property === "x" ? (findElement(active, selected.id)?.x ?? 0.5) : property === "y" ? (findElement(active, selected.id)?.y ?? 0.5) : property === "opacity" ? 1 : property === "scale" ? 1 : 0))}>
                在 {(playheadMs / 1000).toFixed(2)}s 加 {property} 关键帧
              </button>
            ))}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            透明度
            <input aria-label="透明度" type="range" min={0} max={1} step={0.05} defaultValue={1} onChange={event => patch(setElementAnimated(active, selected.id, "opacity", playheadMs, Number(event.target.value)))} />
          </label>
          {tracksForSelected.map(track => (
            <div key={track.property} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ minWidth: 56 }}>{track.property}</span>
              {track.times.map(time => (
                <button key={time} type="button" style={{ ...button, padding: "2px 6px" }} onClick={() => setPlayheadMs(time)} title={`跳到 ${(time / 1000).toFixed(2)}s`}>
                  {(time / 1000).toFixed(2)}s
                </button>
              ))}
              <button type="button" style={button} onClick={() => patch(removeKeyframe(active, selected.id, track.property, playheadMs))}>删除此处关键帧</button>
            </div>
          ))}
        </div>
      )}
      {!active.elements?.length && <p style={{ color: "#8b8b95", margin: 0 }}>这一镜还没有对象。添加文字或色块后可直接拖动，并在播放头处打关键帧。</p>}
    </section>
  );
}
