import { expect, it } from "vitest";
import { PrevizDoc, migratePrevizV1, parsePrevizDocument, PrevizDocV2 } from "./index";
const legacy = () =>
  PrevizDoc.parse({
    schemaVersion: 1,
    id: "source",
    title: "Original rig",
    aspect: "16:9",
    fps: 24,
    stage: { width: 10, depth: 10 },
    props: [],
    actors: [{ id: "actor", name: "Actor", heightM: 1.8, position: [0, 0, 0] }],
    cameras: [
      {
        id: "camera",
        name: "Camera",
        keys: [{ tMs: 0, position: [0, 2, 5], target: { actorId: "actor" } }],
      },
    ],
    shots: [{ id: "shot", cameraId: "camera", startMs: 0, endMs: 2000, subjectIds: ["actor"] }],
  });
const key = (tMs: number) => ({ tMs, position: [0, 0, 0], pose: "walk", phase: tMs / 1000 });
it("reads v1 unchanged and migrates only to a distinct, deep-copied v2 document", () => {
  const original = legacy(),
    before = JSON.stringify(original);
  expect(parsePrevizDocument(original)).toEqual(original);
  expect(() => migratePrevizV1(original, original.id)).toThrow("new document ID");
  const next = migratePrevizV1(original, "copy");
  expect(next.schemaVersion).toBe(2);
  next.actors[0]!.position[0] = 3;
  expect(JSON.stringify(original)).toBe(before);
});
it("strictly roundtrips bounded pose tracks with declared joint rotations", () => {
  const doc = PrevizDocV2.parse({
    ...migratePrevizV1(legacy(), "copy"),
    actorTracks: [
      {
        actorId: "actor",
        keys: [{ ...key(0), joints: [{ joint: "leftKnee", rotationDeg: [45, 0, 0] }] }, key(1000)],
      },
    ],
  });
  expect(parsePrevizDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
});
it("rejects unknown fields, external joint names, duplicate and unordered keys", () => {
  const doc = migratePrevizV1(legacy(), "copy");
  expect(() => parsePrevizDocument({ ...doc, url: "https://invalid.test/model" })).toThrow();
  expect(() =>
    parsePrevizDocument({ ...doc, stage: { ...doc.stage, source: "hidden" } }),
  ).toThrow();
  for (const keys of [
    [key(1), key(0)],
    [key(0), key(0)],
    [{ ...key(0), joints: [{ joint: "vendorRig", rotationDeg: [0, 0, 0] }] }],
  ])
    expect(() =>
      parsePrevizDocument({ ...doc, actorTracks: [{ actorId: "actor", keys }] }),
    ).toThrow();
});
it("rejects missing actors, duplicate tracks, unsupported poses and nonfinite motion", () => {
  const doc = migratePrevizV1(legacy(), "copy"),
    track = { actorId: "actor", keys: [key(0)] };
  for (const tracks of [
    [{ ...track, actorId: "missing" }],
    [track, track],
    [{ ...track, keys: [{ ...key(0), pose: "dance" }] }],
    [{ ...track, keys: [{ ...key(0), position: [Infinity, 0, 0] }] }],
  ])
    expect(() => parsePrevizDocument({ ...doc, actorTracks: tracks })).toThrow();
});
