import { evaluateCamera, exportCamera, project } from "./geometry";
import type { PrevizDoc, Vec3 } from "./schema";
import { evaluateActorPoses } from "./pose";
import type { PrevizDocV2 } from "./v2";
import { threePreviewHtml, type ControlMode } from "./three-preview";

/** Resolve moving camera targets using the same sampled actor pose as the render. */
export function evaluatePrevizFrame(doc: PrevizDocV2, tMs: number) {
  const poses = evaluateActorPoses(doc, tMs);
  const actors = doc.actors.map((actor) => ({
    ...actor,
    position: poses.find((pose) => pose.actorId === actor.id)!.position,
  }));
  const cameras = doc.cameras.map((camera) => ({
    ...camera,
    keys: camera.keys.map((key) => {
      if ("point" in key.target) return key;
      const target = key.target,
        pose = poses.find((item) => item.actorId === target.actorId)!;
      const point: Vec3 = target.offset
        ? [
            pose.position[0] + target.offset[0],
            pose.position[1] + target.offset[1],
            pose.position[2] + target.offset[2],
          ]
        : pose.joints.find((joint) => joint.name === "head")!.position;
      return { ...key, target: { point } };
    }),
  }));
  const document: PrevizDoc = {
    schemaVersion: 1,
    id: doc.id,
    title: doc.title,
    aspect: doc.aspect,
    fps: doc.fps,
    stage: doc.stage,
    props: doc.props,
    actors,
    cameras,
    shots: doc.shots,
  };
  return { document, poses };
}
export function animatedPrevizHtml(
  doc: PrevizDocV2,
  cameraId: string,
  tMs: number,
  near: number,
  far: number,
  mode: ControlMode,
): string {
  if (doc.props.some((prop) => prop.shape === "model" || prop.assetId))
    throw new Error("External models are not supported by the procedural renderer");
  const frame = evaluatePrevizFrame(doc, tMs);
  return threePreviewHtml(
    frame.document,
    exportCamera(frame.document, cameraId, tMs),
    near,
    far,
    mode,
    false,
    frame.poses,
  );
}
export function projectSkeleton(doc: PrevizDocV2, cameraId: string, tMs: number) {
  const frame = evaluatePrevizFrame(doc, tMs),
    camera = evaluateCamera(frame.document, cameraId, tMs);
  const [width, height] = doc.aspect.split(":").map(Number);
  return frame.poses.map((pose) => ({
    actorId: pose.actorId,
    joints: pose.joints.map((joint) => ({
      ...joint,
      projection: project(camera, width! / height!, joint.position),
    })),
  }));
}
