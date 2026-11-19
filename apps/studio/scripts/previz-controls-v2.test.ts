import { expect, it } from "vitest";
import { projectSkeleton, evaluateActorPose } from "../../../packages/previz/src/index";
import { planControlFrame } from "./previz-controls";
import { animatedFixture } from "./previz-motion-fixture";
it("plans all four v2 maps from the same pose and camera, preserving shot-relative time", () => {
  const doc = animatedFixture(),
    before = JSON.stringify(doc);
  const first = planControlFrame(doc, { shot: "shot", frame: 0 });
  doc.shots[0]!.startMs = 2000;
  doc.shots[0]!.endMs = 4000;
  const later = planControlFrame(doc, { shot: "shot", frame: 6 });
  expect(later.metadata.absoluteTimeMs).toBe(2250);
  expect(later.project.scenes.map((scene) => scene.id)).toEqual([
    "rgb",
    "depth",
    "normal",
    "skeleton",
  ]);
  expect(later.project.scenes[0]).not.toEqual(first.project.scenes[0]);
  if (later.metadata.format !== "glint-previz-controls-v2") throw new Error("v2 skeleton missing");
  expect(later.metadata.skeleton.actors).toEqual(projectSkeleton(doc, "camera", 250));
  const pose = evaluateActorPose(doc, "actor", 250);
  expect(later.metadata.skeleton.actors[0]!.joints.map((joint) => joint.position)).toEqual(
    pose.joints.map((joint) => joint.position),
  );
  expect(later.metadata.camera.target).toEqual(
    pose.joints.find((joint) => joint.name === "head")!.position,
  );
  expect(JSON.parse(before).actorTracks).toEqual(doc.actorTracks);
  const rounded = planControlFrame(doc, { shot: "shot", frame: 1 });
  if (rounded.metadata.format !== "glint-previz-controls-v2")
    throw new Error("v2 skeleton missing");
  expect(rounded.metadata.skeleton.timeMs).toBe(42);
  expect(rounded.metadata.skeleton.actors).toEqual(projectSkeleton(doc, "camera", 42));
});
it("retains original resource and frame bounds, rejects external assets and unknown fields", () => {
  const doc = animatedFixture(),
    options = { shot: "shot", frame: 0 };
  for (const patch of [
    { frame: -1 },
    { frame: 48 },
    { width: 2049 },
    { near: 0 },
    { near: 2, far: 1 },
  ])
    expect(() => planControlFrame(doc, { ...options, ...patch })).toThrow();
  expect(() => planControlFrame({ ...doc, external: "https://invalid" }, options)).toThrow();
  doc.props = [
    {
      id: "external",
      name: "External",
      shape: "model",
      assetId: "assets/a.glb",
      position: [0, 0, 0],
      size: [1, 1, 1],
      yawDeg: 0,
    },
  ];
  expect(() => planControlFrame(doc, options)).toThrow();
});
