import {
  type PrevizDocument,
  parsePrevizDocument,
  evaluatePrevizFrame,
  animatedPrevizHtml,
  exportCamera,
  frameTimes,
  lintPreviz,
} from "../../../packages/previz/src/index";
import { threePreviewHtml } from "../../../packages/previz/src/three-preview";
import { parseProject } from "@glintai/scenescript";

export function parsePrevizDraft(input: unknown): PrevizDocument {
  let doc: PrevizDocument;
  try {
    doc = parsePrevizDocument(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown previz field"))
      throw new Error("previz.unknownFields");
    throw new Error("previz.invalidDocument");
  }
  if (!doc.shots.length) throw new Error("previz.noShot");
  if (
    doc.props.some((prop) => prop.shape === "model" || prop.assetId) ||
    (doc.schemaVersion === 1 && doc.actors.some((actor) => actor.pose !== "stand"))
  )
    throw new Error("previz.unsupported");
  if (doc.shots.some((shot) => Math.round(((shot.endMs - shot.startMs) * doc.fps) / 1000) > 432000))
    throw new Error("previz.tooLong");
  for (const camera of doc.cameras)
    for (const key of camera.keys) {
      const resolved = doc.schemaVersion === 2 ? evaluatePrevizFrame(doc, key.tMs).document : doc;
      exportCamera(resolved, camera.id, key.tMs);
    }
  return doc;
}
export async function readPrevizFile(file: File): Promise<PrevizDocument> {
  if (!file.name.toLowerCase().endsWith(".json") || file.size > 2 * 1024 * 1024)
    throw new Error("previz.invalidFile");
  let input: unknown;
  try {
    input = JSON.parse(await file.text());
  } catch {
    throw new Error("previz.invalidDocument");
  }
  return parsePrevizDraft(input);
}
export function editPreviz(
  doc: PrevizDocument,
  kind: "camera" | "actor",
  id: string,
  field: "x" | "y" | "z" | "yaw" | "fov",
  value: string,
): PrevizDocument {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error("previz.invalidNumber");
  const next = structuredClone(doc),
    n = Number(value),
    index = field === "x" ? 0 : field === "y" ? 1 : 2;
  if (kind === "actor") {
    const actor = next.actors.find((item) => item.id === id);
    if (!actor || field === "fov") throw new Error("previz.invalidNumber");
    if (field === "yaw") actor.yawDeg = n;
    else actor.position[index] = n;
  } else {
    const camera = next.cameras.find((item) => item.id === id);
    if (!camera || field === "yaw") throw new Error("previz.invalidNumber");
    if (field === "fov") camera.fovDeg = n;
    else {
      const delta = n - camera.keys[0]!.position[index];
      for (const key of camera.keys) key.position[index] += delta;
    }
  }
  try {
    return parsePrevizDraft(next);
  } catch (error) {
    if (error instanceof Error && error.message === "previz.invalidDocument")
      throw new Error("previz.invalidNumber");
    throw error;
  }
}
export function previzPreview(doc: PrevizDocument, shotId: string, frame: number) {
  const shot = doc.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error("previz.noShot");
  const baseline = doc.schemaVersion === 2 ? evaluatePrevizFrame(doc, 0).document : doc;
  const times = frameTimes(baseline, shotId);
  if (!Number.isInteger(frame) || frame < 0 || frame >= times.length)
    throw new Error("previz.invalidNumber");
  const tMs = times[frame]! - shot.startMs;
  const resolved = doc.schemaVersion === 2 ? evaluatePrevizFrame(doc, tMs).document : doc;
  const camera = exportCamera(resolved, shot.cameraId, tMs);
  return {
    issues: lintPreviz(resolved),
    frames: times.length,
    project: parseProject({
      schemaVersion: 1,
      id: "previz-preview",
      title: "Geometry preview",
      aspect: doc.aspect,
      fps: doc.fps,
      knowledgeSources: [],
      scenes: [
        {
          id: "geometry",
          kind: "html",
          animation: "three",
          html:
            doc.schemaVersion === 2
              ? animatedPrevizHtml(doc, shot.cameraId, tMs, 0.05, 1000, "rgb")
              : threePreviewHtml(doc, camera, 0.05, 1000, "rgb", true),
          narration: { text: "Geometry preview", durationMs: 1000 },
        },
      ],
    }),
  };
}
