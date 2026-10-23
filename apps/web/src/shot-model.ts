import type { AnimationProperty, AnimationTrack, Scene, SceneElement } from "@glintai/scenescript";

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
  if (!["opacity", "scale", "rotate"].includes(property)) return moveElement(scene, elementId, property === "x" ? { x: value, y: 0.5 } : { x: 0.5, y: value }, atMs);
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
