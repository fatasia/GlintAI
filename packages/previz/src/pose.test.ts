import { expect, it } from "vitest";
import { evaluateActorPose, PrevizDocV2 } from "./index";
function fixture() {
  return PrevizDocV2.parse({
    schemaVersion: 2,
    id: "motion",
    title: "Original geometry",
    aspect: "16:9",
    fps: 24,
    stage: { width: 10, depth: 10 },
    props: [],
    cameras: [],
    shots: [],
    actors: [{ id: "actor", name: "Actor", heightM: 2, position: [0, 0, 0] }],
    actorTracks: [
      {
        actorId: "actor",
        keys: [
          { tMs: 0, position: [0, 0, 0], pose: "walk", phase: 0 },
          { tMs: 1000, position: [2, 0, 0], pose: "walk", phase: 1 },
        ],
      },
    ],
  });
}
it("evaluates explicit root movement and gait deterministically at absolute time", () => {
  const doc = fixture(),
    before = JSON.stringify(doc);
  const a = evaluateActorPose(doc, "actor", 0),
    b = evaluateActorPose(doc, "actor", 250);
  expect(b.position).toEqual([0.5, 0, 0]);
  expect(b.joints.find((joint) => joint.name === "leftAnkle")!.position[2]).not.toBe(
    a.joints.find((joint) => joint.name === "leftAnkle")!.position[2],
  );
  expect(evaluateActorPose(doc, "actor", 250)).toEqual(b);
  expect(JSON.stringify(doc)).toBe(before);
});
it("sits with a lowered pelvis and preserves bone lengths under joint overrides", () => {
  const doc = fixture();
  const key = doc.actorTracks[0]!.keys[0]!;
  doc.actorTracks[0]!.keys = [
    { ...key, pose: "sit", joints: [{ joint: "leftShoulder", rotationDeg: [0, 0, 90] }] },
  ];
  const result = evaluateActorPose(doc, "actor", 0);
  const at = (name: string) => result.joints.find((joint) => joint.name === name)!.position;
  expect(at("pelvis")[1]).toBeCloseTo(0.56);
  expect(Math.hypot(...at("leftElbow").map((v, i) => v - at("leftShoulder")[i]!))).toBeCloseTo(
    0.36,
  );
  expect(at("leftKnee")[2]).toBeGreaterThan(0.4);
});
it("clamps outside track endpoints, handles static actors and refuses invalid requests", () => {
  const doc = fixture();
  expect(evaluateActorPose(doc, "actor", 3000)).toEqual(evaluateActorPose(doc, "actor", 1000));
  doc.actorTracks = [];
  expect(evaluateActorPose(doc, "actor", 3000)).toEqual(evaluateActorPose(doc, "actor", 0));
  expect(() => evaluateActorPose(doc, "missing", 0)).toThrow();
  expect(() => evaluateActorPose(doc, "actor", NaN)).toThrow();
  expect(() => evaluateActorPose(doc, "actor", -1)).toThrow();
});
