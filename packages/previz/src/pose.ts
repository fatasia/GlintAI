import type { Actor, Vec3 } from "./schema";
import { JOINT_NAMES, type JointName, type PoseKey, type PrevizDocV2 } from "./v2";

type Matrix = number[];
export interface RigJoint {
  name: JointName;
  parent: JointName | null;
  position: Vec3;
}
export interface ActorPose {
  actorId: string;
  position: Vec3;
  joints: RigJoint[];
}
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function multiply(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3),
      col = i % 3;
    return a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[col + 3]! + a[row * 3 + 2]! * b[col + 6]!;
  });
}
function rotation([x, y, z]: Vec3): Matrix {
  const [sx, sy, sz] = [x, y, z].map((value) => Math.sin(rad(value)));
  const [cx, cy, cz] = [x, y, z].map((value) => Math.cos(rad(value)));
  return multiply(
    multiply([1, 0, 0, 0, cx!, -sx!, 0, sx!, cx!], [cy!, 0, sy!, 0, 1, 0, -sy!, 0, cy!]),
    [cz!, -sz!, 0, sz!, cz!, 0, 0, 0, 1],
  );
}
function transform(m: Matrix, v: Vec3): Vec3 {
  return [0, 1, 2].map(
    (row) => m[row * 3]! * v[0] + m[row * 3 + 1]! * v[1] + m[row * 3 + 2]! * v[2],
  ) as Vec3;
}
const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const interpolate = (a: Vec3, b: Vec3, t: number): Vec3 => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

function keyPair(doc: PrevizDocV2, actor: Actor, tMs: number): [PoseKey, PoseKey, number] {
  const keys = doc.actorTracks.find((track) => track.actorId === actor.id)?.keys;
  const fallback: PoseKey = {
    tMs: 0,
    position: actor.position,
    yawDeg: actor.yawDeg,
    pose: actor.pose as PoseKey["pose"],
    phase: 0,
    joints: [],
    easing: "linear",
  };
  if (!keys?.length) return [fallback, fallback, 0];
  if (tMs <= keys[0]!.tMs) return [keys[0]!, keys[0]!, 0];
  const index = keys.findIndex((key) => key.tMs > tMs);
  if (index < 0) return [keys.at(-1)!, keys.at(-1)!, 0];
  const a = keys[index - 1]!,
    b = keys[index]!;
  const u = (tMs - a.tMs) / (b.tMs - a.tMs);
  return [a, b, a.easing === "linear" ? u : u * u * (3 - 2 * u)];
}
function jointAngles(key: PoseKey, name: JointName, phase: number): Vec3 {
  const left = name.startsWith("left"),
    swing = Math.sin(phase * Math.PI * 2) * (left ? 1 : -1);
  let x = 0;
  if (key.pose === "sit") {
    if (name.endsWith("Hip")) x = -90;
    if (name.endsWith("Knee")) x = 90;
  } else if (key.pose === "walk") {
    if (name.endsWith("Hip")) x = swing * 30;
    if (name.endsWith("Knee")) x = Math.max(0, -swing) * 45;
    if (name.endsWith("Shoulder")) x = -swing * 25;
  }
  return plus(
    [x, 0, 0],
    key.joints.find((joint) => joint.joint === name)?.rotationDeg ?? [0, 0, 0],
  );
}
function definition(name: JointName): { parent: JointName | null; offset: Vec3 } {
  const side = name.startsWith("left") ? -1 : 1;
  if (name === "pelvis") return { parent: null, offset: [0, 0, 0] };
  if (name === "spine") return { parent: "pelvis", offset: [0, 0.2, 0] };
  if (name === "neck") return { parent: "spine", offset: [0, 0.15, 0] };
  if (name === "head") return { parent: "neck", offset: [0, 0.09, 0] };
  const prefix = side < 0 ? "left" : "right";
  if (name.endsWith("Shoulder")) return { parent: "spine", offset: [side * 0.16, 0.1, 0] };
  if (name.endsWith("Elbow")) return { parent: `${prefix}Shoulder`, offset: [0, -0.18, 0] };
  if (name.endsWith("Wrist")) return { parent: `${prefix}Elbow`, offset: [0, -0.17, 0] };
  if (name.endsWith("Hip")) return { parent: "pelvis", offset: [side * 0.09, 0, 0] };
  if (name.endsWith("Knee")) return { parent: `${prefix}Hip`, offset: [0, -0.25, 0] };
  return { parent: `${prefix}Knee`, offset: [0, -0.25, 0] };
}
/** Original procedural rig, evaluated only from document keys and absolute shot-local milliseconds. */
export function evaluateActorPose(doc: PrevizDocV2, actorId: string, tMs: number): ActorPose {
  if (!Number.isFinite(tMs) || tMs < 0) throw new Error("Invalid pose time");
  const actor = doc.actors.find((item) => item.id === actorId);
  if (!actor) throw new Error("Unknown actor");
  const [a, b, t] = keyPair(doc, actor, tMs),
    position = interpolate(a.position, b.position, t);
  const phase = mix(a.phase, b.phase, t),
    yaw = rotation([0, mix(a.yawDeg, b.yawDeg, t), 0]);
  const matrices = new Map<JointName, Matrix>(),
    points = new Map<JointName, Vec3>();
  const joints = JOINT_NAMES.map((name) => {
    const { parent, offset } = definition(name);
    const parentMatrix = parent ? matrices.get(parent)! : yaw;
    const origin = parent
      ? points.get(parent)!
      : plus(position, [
          0,
          actor.heightM * mix(a.pose === "sit" ? 0.28 : 0.52, b.pose === "sit" ? 0.28 : 0.52, t),
          0,
        ]);
    const point = plus(
      origin,
      transform(parentMatrix, offset.map((value) => value * actor.heightM) as Vec3),
    );
    matrices.set(
      name,
      multiply(
        parentMatrix,
        rotation(interpolate(jointAngles(a, name, phase), jointAngles(b, name, phase), t)),
      ),
    );
    points.set(name, point);
    return { name, parent, position: point };
  });
  return { actorId, position, joints };
}
export function evaluateActorPoses(doc: PrevizDocV2, tMs: number): ActorPose[] {
  return doc.actors.map((actor) => evaluateActorPose(doc, actor.id, tMs));
}
