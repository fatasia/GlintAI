import type { Actor, Camera, CameraKey, PrevizDoc, PrevizShot, Vec3 } from "./schema";

export class PrevizError extends Error {
  constructor(readonly code: "unknown-camera" | "unknown-actor" | "unknown-shot" | "degenerate", message: string) { super(message); this.name = "PrevizError"; }
}

const UP: Vec3 = [0, 1, 0];
const FRONT: Vec3 = [0, 0, 1];
const EPS = 1e-9;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < EPS) throw new PrevizError("degenerate", "Cannot normalise a zero-length vector");
  return scale(a, 1 / l);
}

export const aspectRatio = (aspect: PrevizDoc["aspect"]) => aspect === "16:9" ? 16 / 9 : aspect === "9:16" ? 9 / 16 : 1;
const rad = (deg: number) => deg * Math.PI / 180;

/** Unit vector an actor with this yaw faces: yaw 0 → +Z, positive yaw turns toward +X. */
export const facing = (yawDeg: number): Vec3 => [Math.sin(rad(yawDeg)), 0, Math.cos(rad(yawDeg))];

export interface Basis { forward: Vec3; right: Vec3; up: Vec3 }

/** Camera basis from look-at. right = forward × up, up = right × forward (a right-handed camera). */
export function basis(position: Vec3, target: Vec3): Basis {
  const forward = normalize(sub(target, position));
  let side = cross(forward, UP);
  if (length(side) < 1e-6) side = cross(forward, FRONT);
  const right = normalize(side);
  return { forward, right, up: cross(right, forward) };
}

export function actorOf(doc: PrevizDoc, id: string): Actor {
  const actor = doc.actors.find(entry => entry.id === id);
  if (!actor) throw new PrevizError("unknown-actor", `Unknown actor "${id}"`);
  return actor;
}
export function cameraOf(doc: PrevizDoc, id: string): Camera {
  const camera = doc.cameras.find(entry => entry.id === id);
  if (!camera) throw new PrevizError("unknown-camera", `Unknown camera "${id}"`);
  return camera;
}
export function shotOf(doc: PrevizDoc, id: string): PrevizShot {
  const shot = doc.shots.find(entry => entry.id === id);
  if (!shot) throw new PrevizError("unknown-shot", `Unknown shot "${id}"`);
  return shot;
}

export function resolveTarget(doc: PrevizDoc, target: CameraKey["target"]): Vec3 {
  if ("point" in target) return target.point;
  const actor = actorOf(doc, target.actorId);
  return add(actor.position, target.offset ?? [0, actor.heightM * 0.9, 0]);
}

const ease = (kind: CameraKey["easing"], u: number) => kind === "linear" ? u : u * u * (3 - 2 * u);

export interface CameraState { position: Vec3; target: Vec3; fovDeg: number }

/** The camera at time `tMs`. Before the first key and after the last it holds still; a key's easing shapes the segment leaving it. */
export function evaluateCamera(doc: PrevizDoc, cameraId: string, tMs: number): CameraState {
  const camera = cameraOf(doc, cameraId);
  const keys = camera.keys;
  const state = (key: CameraKey): CameraState => ({ position: key.position, target: resolveTarget(doc, key.target), fovDeg: camera.fovDeg });
  const first = keys[0]!, last = keys[keys.length - 1]!;
  if (tMs <= first.tMs) return state(first);
  if (tMs >= last.tMs) return state(last);
  let i = 0;
  while (keys[i + 1]!.tMs <= tMs) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const u = ease(a.easing, (tMs - a.tMs) / (b.tMs - a.tMs));
  return { position: lerp(a.position, b.position, u), target: lerp(resolveTarget(doc, a.target), resolveTarget(doc, b.target), u), fovDeg: camera.fovDeg };
}

export interface Projection { x: number; y: number; depth: number; inFront: boolean }

/** Normalised device coordinates: the frame spans −1…1 in x and y. */
export function project(state: CameraState, aspect: number, point: Vec3): Projection {
  const b = basis(state.position, state.target);
  const v = sub(point, state.position);
  const depth = dot(v, b.forward);
  if (depth <= 0.01) return { x: 0, y: 0, depth, inFront: false };
  const t = Math.tan(rad(state.fovDeg) / 2);
  return { x: dot(v, b.right) / (depth * t * aspect), y: dot(v, b.up) / (depth * t), depth, inFront: true };
}

/** Footprint radius used for collision and for the framing box; a person is about 0.3 m wide per 2 m of height. */
export const actorRadius = (actor: Actor) => actor.heightM * 0.15;
const headPoint = (actor: Actor): Vec3 => add(actor.position, [0, actor.heightM * 0.93, 0]);

function actorCorners(actor: Actor): Vec3[] {
  const r = actorRadius(actor), [px, py, pz] = actor.position;
  const out: Vec3[] = [];
  for (const dx of [-r, r]) for (const dz of [-r, r]) for (const dy of [0, actor.heightM]) out.push([px + dx, py + dy, pz + dz]);
  return out;
}

export interface SubjectMeasure {
  actorId: string;
  distance: number;
  /** Share of the actor's projected box that lies inside the frame, 0…1. */
  visible: number;
  /** Projected height of the actor as a share of the frame height; above 1 means the actor is larger than the frame. */
  heightFraction: number;
  headInFrame: boolean;
  /** Frame height left above the head, as a share of frame height. */
  headroom: number;
  behindCamera: boolean;
}

export function measureSubject(doc: PrevizDoc, state: CameraState, actor: Actor): SubjectMeasure {
  const aspect = aspectRatio(doc.aspect);
  const projected = actorCorners(actor).map(corner => project(state, aspect, corner)).filter(p => p.inFront);
  const centre = add(actor.position, [0, actor.heightM / 2, 0]);
  const distance = length(sub(centre, state.position));
  if (!projected.length) return { actorId: actor.id, distance, visible: 0, heightFraction: 0, headInFrame: false, headroom: 0, behindCamera: true };
  const xs = projected.map(p => p.x), ys = projected.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const area = (x1 - x0) * (y1 - y0);
  const cx0 = Math.max(x0, -1), cx1 = Math.min(x1, 1), cy0 = Math.max(y0, -1), cy1 = Math.min(y1, 1);
  const clipped = cx1 > cx0 && cy1 > cy0 ? (cx1 - cx0) * (cy1 - cy0) : 0;
  const share = area > EPS ? clipped / area : (x0 >= -1 && x0 <= 1 && y0 >= -1 && y0 <= 1 ? 1 : 0);
  const head = project(state, aspect, headPoint(actor));
  // Size is read off the body's centre line (feet to crown) so a deep bounding box does not inflate it at close range.
  const feet = project(state, aspect, actor.position), crown = project(state, aspect, add(actor.position, [0, actor.heightM, 0]));
  const axis = feet.inFront && crown.inFront;
  return {
    actorId: actor.id,
    distance,
    visible: share * (projected.length / 8),
    heightFraction: axis ? Math.abs(crown.y - feet.y) / 2 : (y1 - y0) / 2,
    headInFrame: head.inFront && Math.abs(head.x) <= 1 && Math.abs(head.y) <= 1,
    headroom: axis ? (1 - crown.y) / 2 : (1 - y1) / 2,
    behindCamera: projected.length < 8,
  };
}

/** Wide shows the whole body, medium is about waist-up, close is head and shoulders. A heuristic on measured size, not on a model's opinion. */
export function classifySize(heightFraction: number): "wide" | "medium" | "close" {
  return heightFraction < 1.1 ? "wide" : heightFraction < 2.8 ? "medium" : "close";
}

const TARGET_FRACTION = { wide: 0.5, medium: 1.8, close: 4.0, "over-shoulder": 1.8, insert: 6 } as const;
const AIM_HEIGHT = { wide: 0.5, medium: 0.72, close: 0.88, "over-shoulder": 0.78, insert: 0.9 } as const;

export interface SuggestOptions { actorId: string; size: keyof typeof TARGET_FRACTION; fovDeg?: number; /** Degrees around the actor; 0 is in front of them, positive swings toward +X. */ angleDeg?: number }

/** A camera key that frames `actorId` at the requested size, derived from the actor's measured height and the lens. */
export function suggestCamera(doc: PrevizDoc, options: SuggestOptions): { position: Vec3; target: CameraKey["target"]; fovDeg: number } {
  const actor = actorOf(doc, options.actorId);
  const fovDeg = options.fovDeg ?? 40;
  const distance = actor.heightM / (TARGET_FRACTION[options.size] * 2 * Math.tan(rad(fovDeg) / 2));
  const aim = actor.heightM * AIM_HEIGHT[options.size];
  const direction = facing(actor.yawDeg + (options.angleDeg ?? 0));
  const position = add(actor.position, [direction[0] * distance, aim, direction[2] * distance]);
  return { position, target: { actorId: actor.id, offset: [0, aim, 0] }, fovDeg };
}

export interface CameraExport {
  tMs: number;
  position: Vec3;
  target: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  fovDeg: number;
  aspect: number;
  /** Row-major 4×4 world→camera matrix for a camera that looks down its own −Z (three.js / OpenGL view space). */
  viewMatrix: number[];
}

export function exportCamera(doc: PrevizDoc, cameraId: string, tMs: number): CameraExport {
  const state = evaluateCamera(doc, cameraId, tMs);
  const b = basis(state.position, state.target);
  const p = state.position;
  const back = scale(b.forward, -1);
  return {
    tMs, position: p, target: state.target, forward: b.forward, right: b.right, up: b.up, fovDeg: state.fovDeg, aspect: aspectRatio(doc.aspect),
    viewMatrix: [...b.right, -dot(b.right, p), ...b.up, -dot(b.up, p), ...back, -dot(back, p), 0, 0, 0, 1],
  };
}

/** Frame times of a shot at the document frame rate; the same document always yields the same list. */
export function frameTimes(doc: PrevizDoc, shotId: string): number[] {
  const shot = shotOf(doc, shotId);
  const count = Math.max(1, Math.round(((shot.endMs - shot.startMs) / 1000) * doc.fps));
  return Array.from({ length: count }, (_, i) => Math.round(shot.startMs + (i * 1000) / doc.fps));
}

/** One camera description per frame: the contract a depth / pose / edge renderer is driven by (P-05). */
export function exportShotCameras(doc: PrevizDoc, shotId: string): CameraExport[] {
  const shot = shotOf(doc, shotId);
  return frameTimes(doc, shotId).map(t => exportCamera(doc, shot.cameraId, t - shot.startMs));
}
