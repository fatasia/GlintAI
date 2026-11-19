import { framesForMs, msForFrame, resolveFrameRate, type AnimationProperty, type AnimationTrack, type Easing, type Scene, type SceneElement } from "@glintai/scenescript";

/**
 * Pure model edits for the Shot canvas. The UI never mutates React state in
 * place: every gesture produces a new scene that goes through the same
 * `onChange` path as the rest of the editor (and therefore the shared session).
 */

export function sceneElements(scene: Scene): SceneElement[] {
  return scene.elements ?? [];
}

export function findElement(scene: Scene, elementId: string): SceneElement | undefined {
  return sceneElements(scene).find(element => element.id === elementId);
}

export function findTrack(scene: Scene, elementId: string, property: AnimationProperty): AnimationTrack | undefined {
  return (scene.tracks ?? []).find(track => track.elementId === elementId && track.property === property);
}

function replaceElement(scene: Scene, elementId: string, update: (element: SceneElement) => SceneElement): Scene {
  return { ...scene, elements: sceneElements(scene).map(element => (element.id === elementId ? update(element) : element)) };
}

function replaceTracks(scene: Scene, tracks: AnimationTrack[]): Scene {
  return { ...scene, tracks };
}

export function setElementText(scene: Scene, elementId: string, text: string): Scene {
  return replaceElement(scene, elementId, element => (element.kind === "text" ? { ...element, text } : element));
}

/** Rect controls are bounded to the same contract used by both renderers. */
export function setRectProperty(scene: Scene, elementId: string, property: "w" | "h" | "radius" | "fill", value: number | string): Scene {
  if (property === "fill") {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Invalid shape color");
  } else if (typeof value !== "number" || !Number.isFinite(value) || value < (property === "radius" ? 0 : 0.001) || value > (property === "radius" ? 64 : 1)) throw new Error("Invalid shape geometry");
  return replaceElement(scene, elementId, element => element.kind === "rect" ? { ...element, [property]: value } : element);
}

/** The editable vector brush uses the same geometry contract as a solid rectangle. */
export function setRectAppearance(scene: Scene, elementId: string, appearance: "solid" | "brush"): Scene {
  if (appearance !== "solid" && appearance !== "brush") throw new Error("Invalid shape appearance");
  return replaceElement(scene, elementId, element => element.kind === "rect" ? { ...element, appearance } : element);
}

/** Upsert a keyframe at `atMs`, keeping the list sorted and unique per time. */
export function upsertKeyframe(scene: Scene, elementId: string, property: AnimationProperty, atMs: number, value: number): Scene {
  if (!Number.isInteger(atMs) || atMs < 0) throw new Error("Keyframe time must be a non-negative integer");
  if (!Number.isFinite(value)) throw new Error("Keyframe value must be finite");
  const existing = findTrack(scene, elementId, property);
  const previous = existing?.keyframes.find(key => key.atMs === atMs);
  const keyframes = [...(existing?.keyframes.filter(key => key.atMs !== atMs) ?? []), { ...previous, atMs, value }]
    .sort((a, b) => a.atMs - b.atMs);
  const tracks = existing
    ? (scene.tracks ?? []).map(track => (track === existing ? { ...track, keyframes } : track))
    : [...(scene.tracks ?? []), { elementId, property, keyframes }];
  return replaceTracks(scene, tracks);
}

export function removeKeyframe(scene: Scene, elementId: string, property: AnimationProperty, atMs: number): Scene {
  const existing = findTrack(scene, elementId, property);
  if (!existing) return scene;
  const keyframes = existing.keyframes.filter(key => key.atMs !== atMs);
  const tracks = keyframes.length
    ? (scene.tracks ?? []).map(track => (track === existing ? { ...track, keyframes } : track))
    : (scene.tracks ?? []).filter(track => track !== existing);
  return replaceTracks(scene, tracks);
}

export function moveKeyframeToTime(scene: Scene, elementId: string, property: AnimationProperty, atMs: number, targetMs: number, durationMs: number): Scene {
  const track = findTrack(scene, elementId, property);
  const key = track?.keyframes.find(item => item.atMs === atMs);
  if (!track || !key) throw new Error("当前播放头没有此属性的关键帧。");
  if (!Number.isInteger(targetMs) || targetMs < 0 || targetMs > durationMs) throw new Error("关键帧时间须为镜头范围内的整数毫秒。");
  if (track.keyframes.some(item => item.atMs === targetMs && item !== key)) throw new Error("目标位置已有同属性关键帧，请先移动或删除它。");
  if (targetMs === atMs) return scene;
  const keyframes = track.keyframes.map(item => item === key ? { ...item, atMs: targetMs } : item).sort((a, b) => a.atMs - b.atMs);
  return replaceTracks(scene, (scene.tracks ?? []).map(item => item === track ? { ...item, keyframes } : item));
}

export function moveKeyframeByFrame(scene: Scene, elementId: string, property: AnimationProperty, atMs: number, direction: -1 | 1, fps: number, durationMs: number): { scene: Scene; atMs: number } {
  const rate = resolveFrameRate(fps);
  const frame = framesForMs(atMs, rate) + direction;
  if (frame < 0) throw new Error("关键帧不能移到镜头开始之前。");
  const target = Math.round(msForFrame(frame, rate));
  if (target > durationMs) throw new Error("关键帧不能移到镜头结束之后。");
  return { scene: moveKeyframeToTime(scene, elementId, property, atMs, target, durationMs), atMs: target };
}

/** The easing belongs to the segment arriving at this exact keyframe. */
export function setKeyframeEasing(scene: Scene, elementId: string, property: AnimationProperty, atMs: number, easing: Easing): Scene {
  const existing = findTrack(scene, elementId, property);
  if (!existing?.keyframes.some(key => key.atMs === atMs)) throw new Error("No keyframe at the playhead");
  return replaceTracks(scene, (scene.tracks ?? []).map(track => track === existing ? { ...track, keyframes: track.keyframes.map(key => key.atMs === atMs ? { ...key, easing } : key) } : track));
}

/** Drag a text/rect: animated axes get a keyframe, static axes change the base value. */
export function moveElement(scene: Scene, elementId: string, position: { x: number; y: number }, atMs?: number): Scene {
  const element = findElement(scene, elementId);
  if (!element) throw new Error(`Unknown element: ${elementId}`);
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const axes: Array<[AnimationProperty, number]> = [["x", position.x], ["y", position.y]];
  let next = scene;
  for (const [property, raw] of axes) {
    const value = clamp01(raw);
    if (findTrack(next, elementId, property) && atMs !== undefined) next = upsertKeyframe(next, elementId, property, atMs, value);
    else next = replaceElement(next, elementId, current => ({ ...current, [property]: value }) as SceneElement);
  }
  return next;
}

/** Opacity/scale/rotate have no base field: editing them always writes a keyframe. */
export function setElementAnimated(scene: Scene, elementId: string, property: AnimationProperty, atMs: number, value: number): Scene {
  if (property === "x" || property === "y") {
    if (!findElement(scene, elementId)) throw new Error(`Unknown element: ${elementId}`);
    if (!Number.isFinite(value)) throw new Error("Position must be finite");
    const bounded = Math.min(1, Math.max(0, value));
    return findTrack(scene, elementId, property)
      ? upsertKeyframe(scene, elementId, property, atMs, bounded)
      : replaceElement(scene, elementId, element => ({ ...element, [property]: bounded }) as SceneElement);
  }
  const bounded = property === "opacity" ? Math.min(1, Math.max(0, value)) : value;
  return upsertKeyframe(scene, elementId, property, atMs, bounded);
}

export function addElement(scene: Scene, element: SceneElement): Scene {
  if (findElement(scene, element.id)) throw new Error(`Element already exists: ${element.id}`);
  if (sceneElements(scene).length >= 20) throw new Error("A scene supports at most 20 elements");
  return { ...scene, elements: [...sceneElements(scene), element] };
}

export function removeElement(scene: Scene, elementId: string): Scene {
  return { ...scene, elements: sceneElements(scene).filter(element => element.id !== elementId), tracks: (scene.tracks ?? []).filter(track => track.elementId !== elementId) };
}

export function keyframeTimes(scene: Scene, elementId: string, property: AnimationProperty): number[] {
  return (findTrack(scene, elementId, property)?.keyframes ?? []).map(key => key.atMs).sort((a, b) => a - b);
}
