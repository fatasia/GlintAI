import { parseProject } from "./parse";
import { buildTimeline, sceneDurationMs } from "./timeline";
import type { Scene, SceneScriptProject, VideoScene } from "./types";

/** Millisecond deltas are safe integers; source trim positions remain seconds. */
export type TimelineCommand =
  | { type: "lock"; sceneId: string; locked: boolean }
  | { type: "ripple-delete"; sceneId: string }
  | { type: "trim"; sceneId: string; edge: "start" | "end"; deltaMs: number }
  /** Positive roll moves the boundary later (extends current, shortens next). */
  | { type: "roll"; sceneId: string; deltaMs: number }
  /** Positive slip selects later source footage, without moving the scene. */
  | { type: "slip"; sceneId: string; deltaMs: number }
  | { type: "split"; sceneId: string; atMs: number; newSceneId: string; duplicateText?: boolean };

const MIN_DURATION_MS = 100;
const SOURCE_EPSILON = 1e-9;
const STATIC_KINDS = new Set(["title", "bullets", "definition", "quote", "comparison", "code", "image", "diagram", "video"]);

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer in milliseconds`);
}

function duration(value: number): void {
  integer(value, "durationMs");
  if (value < MIN_DURATION_MS) throw new Error(`Scene duration must be at least ${MIN_DURATION_MS}ms`);
}

function unlocked(scene: Scene): void {
  if (scene.locked) throw new Error(`Scene "${scene.id}" is locked`);
}

function retimeable(project: SceneScriptProject, scene: Scene): void {
  const n = scene.narration;
  if (n.audioRef !== undefined || n.audioOffsetMs !== undefined || n.segments?.length) {
    throw new Error(`Scene "${scene.id}" has audio or narration timings; retiming is unsupported`);
  }
  if (scene.tracks?.length || scene.effects?.some(effect => effect.keyframes?.length || effect.startMs !== undefined || effect.endMs !== undefined) || scene.beatPulse || scene.transition ||
      (scene.camera && scene.camera.type !== "static") || !STATIC_KINDS.has(scene.kind)) {
    throw new Error(`Scene "${scene.id}" has animation or unsupported dynamic content; continuity cannot be preserved`);
  }
  if (project.sfx?.some(cue => cue.sceneId === scene.id)) {
    throw new Error(`Scene "${scene.id}" has SFX; retiming is unsupported`);
  }
}

function withDuration(scene: Scene, durationMs: number): Scene {
  duration(durationMs);
  return { ...scene, narration: { ...scene.narration, durationMs } };
}

/** No media probe is available: an explicit trimEndSec is the known upper bound.
 * Without it, only the currently consumed window is known. Never invent handles.
 */
function sourceWindow(scene: VideoScene): { start: number; end: number; limit: number; speed: number } {
  const speed = scene.speed ?? 1;
  const start = scene.trimStartSec ?? 0;
  const end = start + sceneDurationMs(scene) * speed / 1000;
  const limit = scene.trimEndSec ?? end;
  if (![start, end, limit].every(Number.isFinite) || limit <= start || end > limit + SOURCE_EPSILON) {
    throw new Error(`Scene "${scene.id}" source trim is out of bounds`);
  }
  return { start, end, limit, speed };
}

function videoWindow(scene: VideoScene, start: number, end: number, limit: number): VideoScene {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > limit + SOURCE_EPSILON) {
    throw new Error(`Scene "${scene.id}" source trim is out of bounds; extra source handles are not known`);
  }
  return { ...scene, trimStartSec: start, trimEndSec: end };
}

function trim(scene: Scene, edge: "start" | "end", deltaMs: number): Scene {
  const resized = withDuration(scene, sceneDurationMs(scene) - deltaMs);
  if (scene.kind !== "video") return resized;
  const { start, end, limit, speed } = sourceWindow(scene);
  const delta = deltaMs * speed / 1000;
  return { ...videoWindow(scene, edge === "start" ? start + delta : start,
    edge === "end" ? end - delta : end, limit), narration: resized.narration };
}

function assertLockedPositions(before: SceneScriptProject, after: SceneScriptProject): void {
  const positions = new Map(buildTimeline(after).entries.map(entry => [entry.scene.id, entry]));
  for (const entry of buildTimeline(before).entries) {
    if (!entry.scene.locked) continue;
    const next = positions.get(entry.scene.id);
    if (!next || next.startMs !== entry.startMs || next.durationMs !== entry.durationMs) {
      throw new Error(`Edit would move locked scene "${entry.scene.id}"`);
    }
  }
}

/** Conservative scene edits, not a full NLE. Throws rather than dropping audio
 * or restarting unsupported animation. Both input and result pass parseProject.
 */
export function editTimeline(project: SceneScriptProject, command: TimelineCommand): SceneScriptProject {
  const before = parseProject(project);
  const index = before.scenes.findIndex(scene => scene.id === command.sceneId);
  if (index < 0) throw new Error(`Unknown scene ID "${command.sceneId}"`);
  const scenes = [...before.scenes];
  const scene = scenes[index]!;
  for (const item of scenes) {
    duration(sceneDurationMs(item));
    if (item.kind === "video") sourceWindow(item);
  }
  if (command.type === "lock") {
    if (typeof command.locked !== "boolean") throw new Error("locked must be boolean");
    scenes[index] = { ...scene, locked: command.locked };
    return parseProject({ ...before, scenes });
  }
  unlocked(scene);
  if ("deltaMs" in command) integer(command.deltaMs, "deltaMs");
  // Neighbor entrances can overlap the edited window or depend on its contents.
  if (command.type !== "slip" && scenes[index + 1]?.transition) {
    throw new Error("Next scene has a transition; boundary continuity cannot be preserved");
  }
  switch (command.type) {
    case "ripple-delete":
      if (scenes.length === 1) throw new Error("Cannot delete the last scene");
      if (scene.transition || before.sfx?.some(cue => cue.sceneId === scene.id)) {
        throw new Error("Cannot delete a scene with transition or SFX references");
      }
      scenes.splice(index, 1);
      break;
    case "trim":
      if (command.edge !== "start" && command.edge !== "end") throw new Error("Unknown trim edge");
      retimeable(before, scene);
      scenes[index] = trim(scene, command.edge, command.deltaMs);
      break;
    case "roll": {
      const next = scenes[index + 1];
      if (!next) throw new Error("Roll requires a next scene");
      unlocked(next);
      retimeable(before, scene);
      retimeable(before, next);
      // Also protect the boundary after the resized next scene.
      if (scenes[index + 2]?.transition) throw new Error("Following transition prevents a safe roll");
      scenes[index] = trim(scene, "end", -command.deltaMs);
      scenes[index + 1] = trim(next, "start", command.deltaMs);
      break;
    }
    case "slip": {
      if (scene.kind !== "video") throw new Error("Slip requires a video scene");
      const { start, end, limit, speed } = sourceWindow(scene);
      const shift = command.deltaMs * speed / 1000;
      scenes[index] = videoWindow(scene, start + shift, end + shift, limit);
      break;
    }
    case "split": {
      integer(command.atMs, "atMs");
      if (scenes.some(item => item.id === command.newSceneId)) throw new Error(`Duplicate scene ID "${command.newSceneId}"`);
      retimeable(before, scene);
      // Narration.text is required by the schema, so no implicit empty or copied narration.
      if (command.duplicateText !== true) throw new Error("Split requires explicit duplicateText: true for narration");
      let left = withDuration(scene, command.atMs);
      let right = withDuration({ ...scene, id: command.newSceneId }, sceneDurationMs(scene) - command.atMs);
      if (scene.kind === "video") {
        const { start, end, limit, speed } = sourceWindow(scene);
        const boundary = start + command.atMs * speed / 1000;
        left = { ...videoWindow(scene, start, boundary, limit), narration: left.narration };
        right = { ...videoWindow(scene, boundary, end, limit), id: command.newSceneId, narration: right.narration };
      }
      scenes.splice(index, 1, left, right);
      break;
    }
    default:
      throw new Error("Unknown timeline command");
  }
  const after = parseProject({ ...before, scenes });
  assertLockedPositions(before, after);
  return after;
}
