import {
  evaluateActorPose,
  evaluateCamera,
  evaluatePrevizFrame,
  migratePrevizV1,
  type CameraKey,
  type PoseKey,
  type PrevizDocument,
} from "../../../packages/previz/src/index";
import { parsePrevizDraft } from "./storyboard-previz-model";

export type KeyEdit = { action: "add" | "remove" | "replace"; index?: number; tMs?: number };
export function cameraKeyEdit(
  source: PrevizDocument,
  cameraId: string,
  edit: KeyEdit,
  replacement?: CameraKey,
): PrevizDocument {
  const next = structuredClone(source),
    camera = next.cameras.find((item) => item.id === cameraId);
  if (!camera) throw new Error("previz.invalidNumber");
  if (edit.action === "add") {
    const time = edit.tMs ?? -1;
    const doc = source.schemaVersion === 2 ? evaluatePrevizFrame(source, time).document : source;
    const state = evaluateCamera(doc, cameraId, time);
    camera.keys.push({
      tMs: time,
      position: state.position,
      target: { point: state.target },
      easing: "linear",
    });
  } else {
    if (!Number.isInteger(edit.index) || !camera.keys[edit.index!])
      throw new Error("previz.invalidNumber");
    if (edit.action === "remove") camera.keys.splice(edit.index!, 1);
    else if (replacement) camera.keys[edit.index!] = structuredClone(replacement);
    else throw new Error("previz.invalidNumber");
  }
  camera.keys.sort((a, b) => a.tMs - b.tMs);
  return parsePrevizDraft(next);
}

export function actorKeyEdit(
  source: PrevizDocument,
  actorId: string,
  edit: KeyEdit,
  replacement?: PoseKey,
): PrevizDocument {
  if (source.schemaVersion !== 2) throw new Error("previz.migrateFirst");
  const next = structuredClone(source),
    actor = next.actors.find((item) => item.id === actorId);
  if (!actor) throw new Error("previz.invalidNumber");
  let track = next.actorTracks.find((item) => item.actorId === actorId);
  if (edit.action === "add") {
    const tMs = edit.tMs ?? -1,
      pose = evaluateActorPose(source, actorId, tMs);
    if (!track) {
      track = { actorId, keys: [] };
      next.actorTracks.push(track);
    }
    const before: PoseKey = [...track.keys].reverse().find((key) => key.tMs <= tMs) ?? {
      tMs,
      position: pose.position,
      yawDeg: actor.yawDeg,
      pose: actor.pose,
      phase: 0,
      joints: [],
      easing: "linear",
    };
    track.keys.push({ ...before, tMs, position: pose.position });
  } else {
    if (!track || !Number.isInteger(edit.index) || !track.keys[edit.index!])
      throw new Error("previz.invalidNumber");
    if (edit.action === "remove") track.keys.splice(edit.index!, 1);
    else if (replacement) track.keys[edit.index!] = structuredClone(replacement);
    else throw new Error("previz.invalidNumber");
  }
  if (track) {
    track.keys.sort((a, b) => a.tMs - b.tMs);
    if (!track.keys.length) next.actorTracks = next.actorTracks.filter((item) => item !== track);
  }
  return parsePrevizDraft(next);
}

export function migrateDraftCopy(source: PrevizDocument, newId: string): PrevizDocument {
  if (source.schemaVersion !== 1) throw new Error("previz.invalidDocument");
  return parsePrevizDraft(migratePrevizV1(source, newId));
}
