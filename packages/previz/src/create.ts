import { PrevizDocV2 } from "./v2";
/** A small editable scene using only the original procedural actor rig. No assets or side effects. */
export function createPrevizDocument(id: string, title: string): PrevizDocV2 {
  return PrevizDocV2.parse({
    schemaVersion: 2,
    id,
    title,
    aspect: "16:9",
    fps: 24,
    stage: { width: 10, depth: 10 },
    props: [],
    actors: [{ id: "actor", name: "Actor", heightM: 1.7, position: [0, 0, 0], pose: "stand" }],
    actorTracks: [],
    cameras: [
      {
        id: "camera",
        name: "Camera",
        fovDeg: 40,
        keys: [{ tMs: 0, position: [3, 2, 5], target: { actorId: "actor" } }],
      },
    ],
    shots: [{ id: "shot", cameraId: "camera", startMs: 0, endMs: 2000, subjectIds: ["actor"] }],
  });
}
