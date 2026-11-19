import { z } from "zod";
import { Actor, PrevizDoc } from "./schema";

export const JOINT_NAMES = [
  "pelvis",
  "spine",
  "neck",
  "head",
  "leftShoulder",
  "leftElbow",
  "leftWrist",
  "rightShoulder",
  "rightElbow",
  "rightWrist",
  "leftHip",
  "leftKnee",
  "leftAnkle",
  "rightHip",
  "rightKnee",
  "rightAnkle",
] as const;
export type JointName = (typeof JOINT_NAMES)[number];
export const Pose = z.enum(["stand", "sit", "walk"]);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const angle = finite.min(-360).max(360);
export const PoseKey = z
  .object({
    tMs: z.number().int().min(0).max(3_600_000),
    position: vector,
    yawDeg: angle.default(0),
    pose: Pose,
    /** Explicit gait cycles; interpolated rather than advanced by wall-clock time. */
    phase: finite.min(0).max(1000).default(0),
    /** Local XYZ Euler degrees added to the procedural pose; fixed, original rig only. */
    joints: z
      .array(
        z
          .object({ joint: z.enum(JOINT_NAMES), rotationDeg: z.tuple([angle, angle, angle]) })
          .strict(),
      )
      .max(JOINT_NAMES.length)
      .default([]),
    easing: z.enum(["linear", "ease-in-out"]).default("linear"),
  })
  .strict();
export const ActorTrack = z
  .object({
    actorId: z.string().min(1).max(80),
    keys: z.array(PoseKey).min(1).max(200),
  })
  .strict();
const V2Shape = PrevizDoc.innerType()
  .extend({
    schemaVersion: z.literal(2),
    actors: z.array(Actor.extend({ pose: Pose.default("stand") }).strict()).max(40),
    actorTracks: z.array(ActorTrack).max(40),
  })
  .strict();
export const PrevizDocV2 = V2Shape.superRefine((doc, ctx) => {
  const legacy = PrevizDoc.safeParse({ ...doc, schemaVersion: 1 });
  if (!legacy.success) for (const issue of legacy.error.issues) ctx.addIssue(issue);
  const seen = new Set<string>();
  let keyCount = 0;
  for (const [index, track] of doc.actorTracks.entries()) {
    if (seen.has(track.actorId) || !doc.actors.some((actor) => actor.id === track.actorId))
      ctx.addIssue({
        code: "custom",
        path: ["actorTracks", index],
        message: "Unknown or duplicate actor track",
      });
    seen.add(track.actorId);
    keyCount += track.keys.length;
    for (const [k, key] of track.keys.entries()) {
      if (k && key.tMs <= track.keys[k - 1]!.tMs)
        ctx.addIssue({
          code: "custom",
          path: ["actorTracks", index, "keys", k],
          message: "Pose keys must increase strictly",
        });
      if (new Set(key.joints.map((joint) => joint.joint)).size !== key.joints.length)
        ctx.addIssue({
          code: "custom",
          path: ["actorTracks", index, "keys", k],
          message: "Duplicate joint override",
        });
    }
  }
  if (keyCount > 2000)
    ctx.addIssue({ code: "custom", message: "At most 2000 pose keys per document" });
});
export type PoseKey = z.infer<typeof PoseKey>;
export type ActorTrack = z.infer<typeof ActorTrack>;
export type PrevizDocV2 = z.infer<typeof PrevizDocV2>;
export type PrevizDocument = PrevizDoc | PrevizDocV2;

function rejectUnknown(input: unknown, parsed: unknown): void {
  if (!input || typeof input !== "object" || !parsed || typeof parsed !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key))
      throw new Error(`Unknown previz field: ${key}`);
    rejectUnknown(value, (parsed as Record<string, unknown>)[key]);
  }
}
export function parsePrevizDocument(input: unknown): PrevizDocument {
  const version =
    input && typeof input === "object"
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const parsed = version === 2 ? PrevizDocV2.parse(input) : PrevizDoc.parse(input);
  rejectUnknown(input, parsed);
  return parsed;
}
/** An explicit copy only; caller owns persistence, original IDs are never silently reused. */
export function migratePrevizV1(input: PrevizDoc, newId: string): PrevizDocV2 {
  const original = PrevizDoc.parse(input);
  if (newId === original.id) throw new Error("Migration requires a new document ID");
  return PrevizDocV2.parse({
    ...structuredClone(original),
    schemaVersion: 2,
    id: newId,
    actorTracks: [],
  });
}
