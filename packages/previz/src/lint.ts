import { actorOf, actorRadius, classifySize, evaluateCamera, measureSubject, sub, type CameraState } from "./geometry";
import type { Actor, PrevizDoc, PrevizShot, Prop, Vec3 } from "./schema";

export type IssueLevel = "error" | "warn";
export interface PrevizIssue { level: IssueLevel; code: string; where: string; message: string }

const TOO_CLOSE_M = 0.5;
const MIN_VISIBLE_WIDE = 0.9;
const JUMP_CUT_DEG = 30;

const rad = (deg: number) => deg * Math.PI / 180;

function insideProp(point: Vec3, prop: Prop, margin = 0): boolean {
  const dx = point[0] - prop.position[0], dz = point[2] - prop.position[2];
  const cos = Math.cos(rad(-prop.yawDeg)), sin = Math.sin(rad(-prop.yawDeg));
  const lx = dx * cos + dz * sin, lz = -dx * sin + dz * cos;
  return Math.abs(lx) <= prop.size[0] / 2 + margin && Math.abs(lz) <= prop.size[2] / 2 + margin && point[1] >= prop.position[1] - margin && point[1] <= prop.position[1] + prop.size[1] + margin;
}

const sampleTimes = (shot: PrevizShot): number[] => {
  const length = shot.endMs - shot.startMs;
  return [0, Math.round(length / 2), length];
};

const horizontalAngle = (from: Vec3, to: Vec3) => Math.atan2(to[0] - from[0], to[2] - from[2]) * 180 / Math.PI;
const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Measures the document and reports what is wrong, as numbers a person or an agent can act on.
 * A rule fires on geometry, not on how a render looks: measurement outranks a model's impression.
 * Camera key times are relative to the start of the shot that uses the camera.
 */
export function lintPreviz(doc: PrevizDoc): PrevizIssue[] {
  const issues: PrevizIssue[] = [];
  const add = (level: IssueLevel, code: string, where: string, message: string) => issues.push({ level, code, where, message });
  const halfW = doc.stage.width / 2, halfD = doc.stage.depth / 2;

  for (const actor of doc.actors) {
    const [x, , z] = actor.position;
    if (Math.abs(x) > halfW || Math.abs(z) > halfD) add("error", "actor-off-stage", actor.id, `${actor.name} 站在舞台之外（x=${x}，z=${z}；舞台 ${doc.stage.width}×${doc.stage.depth} m）`);
    for (const prop of doc.props) {
      if (insideProp(actor.position, prop)) add("error", "actor-in-prop", actor.id, `${actor.name} 穿进了「${prop.name}」`);
    }
  }
  for (let i = 0; i < doc.actors.length; i++) {
    for (let j = i + 1; j < doc.actors.length; j++) {
      const a = doc.actors[i]!, b = doc.actors[j]!;
      const gap = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) - (actorRadius(a) + actorRadius(b));
      if (gap < 0 && Math.abs(a.position[1] - b.position[1]) < Math.min(a.heightM, b.heightM)) add("error", "actor-overlap", `${a.id},${b.id}`, `${a.name} 与 ${b.name} 重叠 ${Math.round(-gap * 100)} cm`);
    }
  }

  const ordered = [...doc.shots].sort((x, y) => x.startMs - y.startMs);
  const stateAt = (shot: PrevizShot, localMs: number): CameraState | undefined => {
    try { return evaluateCamera(doc, shot.cameraId, localMs); } catch { return undefined; }
  };

  for (const shot of ordered) {
    const subjects: Actor[] = [];
    for (const id of shot.subjectIds) { try { subjects.push(actorOf(doc, id)); } catch { /* reported by the schema */ } }
    for (const local of sampleTimes(shot)) {
      const state = stateAt(shot, local);
      if (!state) continue;
      const at = `${shot.id}@${shot.startMs + local}ms`;
      for (const prop of doc.props) if (insideProp(state.position, prop, 0.05)) add("error", "camera-inside-prop", at, `机位在「${prop.name}」里面，画面会被遮住`);
      subjects.forEach((actor, index) => {
        const m = measureSubject(doc, state, actor);
        if (m.behindCamera && m.visible === 0) { add("error", "subject-behind-camera", at, `${actor.name} 在镜头背后`); return; }
        const wide = classifySize(m.heightFraction) === "wide";
        if (!m.headInFrame) add("error", "subject-out-of-frame", at, `${actor.name} 的头部不在画面内`);
        else if (wide && m.visible < MIN_VISIBLE_WIDE) add("error", "subject-out-of-frame", at, `${actor.name} 只有 ${Math.round(m.visible * 100)}% 在画面内（远景需要至少 ${MIN_VISIBLE_WIDE * 100}%）`);
        if (m.distance < TOO_CLOSE_M) add("warn", "camera-too-close", at, `机位离 ${actor.name} 只有 ${m.distance.toFixed(2)} m`);
        if (index === 0 && local === Math.round((shot.endMs - shot.startMs) / 2) && shot.intendedSize && shot.intendedSize !== "insert") {
          const measured = classifySize(m.heightFraction);
          const expected = shot.intendedSize === "over-shoulder" ? "medium" : shot.intendedSize;
          if (measured !== expected) add("warn", "size-mismatch", shot.id, `分镜要求「${shot.intendedSize}」，实测是「${measured}」（主体占画面高度 ${Math.round(m.heightFraction * 100)}%）`);
        }
      });
    }
  }

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!, next = ordered[i]!;
    const a = stateAt(prev, prev.endMs - prev.startMs), b = stateAt(next, 0);
    if (!a || !b) continue;
    const shared = next.subjectIds.filter(id => prev.subjectIds.includes(id));
    if (!shared.length) continue;
    const subject = doc.actors.find(actor => actor.id === shared[0]);
    if (subject) {
      const turn = angleBetween(horizontalAngle(subject.position, a.position), horizontalAngle(subject.position, b.position));
      const sameSize = classifySize(measureSubject(doc, a, subject).heightFraction) === classifySize(measureSubject(doc, b, subject).heightFraction);
      if (turn < JUMP_CUT_DEG && sameSize) add("warn", "jump-cut", `${prev.id}→${next.id}`, `两镜对 ${subject.name} 的机位只差 ${Math.round(turn)}°且景别相同，剪辑会像跳切；至少转 ${JUMP_CUT_DEG}° 或换景别`);
    }
    if (shared.length >= 2) {
      const [p, q] = [actorOf(doc, shared[0]!), actorOf(doc, shared[1]!)];
      const axis = sub(q.position, p.position);
      const side = (camera: Vec3) => Math.sign(axis[0] * (camera[2] - p.position[2]) - axis[2] * (camera[0] - p.position[0]));
      if (side(a.position) !== 0 && side(a.position) !== side(b.position)) add("warn", "axis-cross", `${prev.id}→${next.id}`, `机位越过了 ${p.name} 与 ${q.name} 的视线轴（180° 原则），观众会以为两人换了位置`);
    }
  }

  return issues;
}
