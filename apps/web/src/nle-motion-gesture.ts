import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { NleClip } from "@glintai/scenescript";
import { clampMotion, motionFrameMs, moveMotionKeyframe, patchMotionKeyframe } from "./nle-motion";
import { sampleMotionGesture, type MotionGesturePoint } from "./nle-motion-record";

export interface NleMotionEditorProps {
  clip: NleClip; fps: number;
  /** Project time, not source time or clip-local time. */
  playheadMs: number;
  onSeek(ms: number): void;
  onChange(clip: NleClip): void;
  locked?: boolean;
}
type Drag = { mode: "time" | "path" | "record"; pointerId: number; source: NleClip; fps: number; ms: number; start: number; points: MotionGesturePoint[]; next: NleClip; moved: boolean; target: SVGSVGElement };

export function useMotionGesture(props: NleMotionEditorProps) {
  const { clip, fps, locked, onChange, onSeek } = props;
  const [selected, setSelected] = useState<number | null>(null), [draft, setDraft] = useState<NleClip | null>(null);
  const [recording, setRecording] = useState(false), [message, setMessage] = useState("");
  const drag = useRef<Drag | null>(null);
  const current = useRef(props); current.current = props;
  const valid = (value: Drag) => current.current.clip === value.source && !current.current.locked && current.current.fps === value.fps;
  const release = (value: Drag | null) => {
    if (value?.target.hasPointerCapture?.(value.pointerId)) value.target.releasePointerCapture(value.pointerId);
  };
  const cancel = () => { const value = drag.current; drag.current = null; release(value); setDraft(null); setRecording(false); setMessage("已取消，未写入关键帧。"); };
  useEffect(() => {
    const value = drag.current;
    if (value && !valid(value)) cancel();
    setSelected(value => clip.keyframes?.some(frame => frame.ms === value) ? value : null);
    if (locked) setRecording(false);
  }, [clip, fps, locked]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); const value = drag.current; drag.current = null; release(value); };
  }, []);
  const apply = (operation: () => NleClip, ms?: number) => {
    if (locked) { setMessage("片段已锁定，请先解锁。 "); return; }
    try {
      const next = operation();
      if (next !== clip) onChange(next);
      if (ms !== undefined) setSelected(ms);
      setMessage("已更新关键帧，可使用工程撤销。 ");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "更新失败，请重新选择关键帧。 "); }
  };
  const seek = (ms: number) => onSeek(clip.startMs + clampMotion(ms, 0, clip.durationMs));
  const choose = (ms: number) => { setSelected(ms); seek(ms); };
  const point = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: clampMotion(((event.clientX - box.left) / (box.width || 1) * 300 - 150) / 130, -1, 1), y: clampMotion(((event.clientY - box.top) / (box.height || 1) * 180 - 90) / 70, -1, 1) };
  };
  const time = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return motionFrameMs(((event.clientX - box.left) / (box.width || 1) * 300 - 12) / 276 * clip.durationMs, clip.durationMs, fps);
  };
  const start = (event: ReactPointerEvent<SVGSVGElement>, surface: "time" | "path") => {
    if (event.button !== 0 || drag.current) return;
    const frame = (event.target as Element).closest("[data-motion-ms]");
    const ms = frame ? Number(frame.getAttribute("data-motion-ms")) : null;
    if (ms !== null) choose(ms);
    if (locked) { if (surface === "time" && ms === null) seek(time(event)); return; }
    if (surface === "time" && ms === null) { seek(time(event)); return; }
    if (surface === "path" && !recording && ms === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const mode = surface === "path" && recording ? "record" : surface;
    drag.current = { mode, pointerId: event.pointerId, source: clip, fps, ms: ms ?? 0, start: event.timeStamp, points: [], next: clip, moved: false, target: event.currentTarget };
    if (mode === "record") {
      drag.current.points.push({ elapsedMs: 0, ...point(event) });
      setMessage("正在采样手势，松开后合并写入一次。 ");
    }
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    if (!valid(value)) { cancel(); return; }
    try {
      if (value.mode === "time") {
        const ms = time(event);
        value.next = moveMotionKeyframe(value.source, value.ms, ms, fps);
        setSelected(ms); seek(ms);
      } else if (value.mode === "path") value.next = patchMotionKeyframe(value.source, value.ms, point(event));
      else {
        const sample = { elapsedMs: event.timeStamp - value.start, ...point(event) };
        const previous = value.points[value.points.length - 1]!;
        if (sample.elapsedMs === previous.elapsedMs) value.points[value.points.length - 1] = sample;
        else value.points.push(sample);
        if (value.points.length > 2048) value.points = value.points.filter((_, index, all) => index === 0 || index === all.length - 1 || index % 2 === 0);
        value.next = sampleMotionGesture(value.source, value.points, fps);
      }
      value.moved = true; setDraft(value.next); setMessage("预览中，松开保存；Esc 取消。 ");
    } catch (cause) {
      value.next = value.source; value.moved = false; setDraft(null);
      setMessage(cause instanceof Error ? cause.message : "此位置不能保存，请换一个位置。 ");
    }
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    // Capture final pointer position, including fast gestures with no intermediate pointermove.
    if (value.mode === "record" || value.moved) move(event);
    drag.current = null; release(value); setDraft(null); setRecording(false);
    if (!valid(value) || !value.moved || value.next === value.source) return;
    try { onChange(value.next); setMessage(value.mode === "record" ? `已录制并合并 ${value.next.keyframes?.length ?? 0} 个关键帧。` : "已保存关键帧。 "); }
    catch { setMessage("保存失败，请重试。 "); }
  };
  return { selected, setSelected, draft: draft && drag.current && valid(drag.current) ? draft : null, recording, setRecording, message, setMessage, apply, seek, choose, cancel, start, move, finish, dragging: () => Boolean(drag.current) };
}
