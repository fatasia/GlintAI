import { z } from "zod";

/**
 * Previs document: the single source of truth for a 3D previsualisation.
 * Renders, control images and measurements are all derived from it, never the other way round.
 *
 * Coordinate convention (one place, used by every function in this package):
 *   - right-handed, +Y up, an asset's front faces +Z, metres, like glTF 2.0;
 *   - therefore the +X axis is on the asset's left when you look at its front;
 *   - yaw is degrees about +Y, 0 faces +Z, positive turns from +Z toward +X;
 *   - a camera's basis always comes from look-at (position → target); there is no separate camera rotation to get wrong.
 */
export const PREVIZ_VERSION = 1;
export const CONVENTION = { handedness: "right", up: [0, 1, 0], front: [0, 0, 1], unit: "m", yaw: "degrees about +Y; 0 faces +Z; positive turns toward +X" } as const;

const id = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const num = z.number().finite();
const Vec3 = z.tuple([num, num, num]);
const Positive = num.positive().max(1000);

export const Easing = z.enum(["linear", "ease-in-out"]);

export const Prop = z.object({
  id,
  name: z.string().min(1).max(80),
  shape: z.enum(["box", "cylinder", "sphere", "model"]),
  /** For `model`: the library asset this prop renders (P-01). */
  assetId: z.string().min(1).max(120).optional(),
  /** Centre of the footprint on the floor; the prop stands on y = position.y. */
  position: Vec3,
  /** Width (x), height (y), depth (z) in metres. */
  size: z.tuple([Positive, Positive, Positive]),
  yawDeg: num.default(0),
});

export const Actor = z.object({
  id,
  name: z.string().min(1).max(80),
  /** Link to the drama character, so a shot's cast and its mannequins stay in step. */
  characterId: z.string().min(1).max(80).optional(),
  heightM: num.min(0.3).max(3),
  position: Vec3,
  yawDeg: num.default(0),
  pose: z.string().min(1).max(60).default("stand"),
});

/** A camera aim point: a fixed spot, or an actor with an offset (default: eye height). */
export const Target = z.union([
  z.object({ point: Vec3 }),
  z.object({ actorId: id, offset: Vec3.optional() }),
]);

export const CameraKey = z.object({
  /** Milliseconds from the start of the shot that uses the camera, so one camera can serve several shots. */
  tMs: z.number().int().min(0).max(3_600_000),
  position: Vec3,
  target: Target,
  easing: Easing.default("ease-in-out"),
});
export const Camera = z.object({
  id,
  name: z.string().min(1).max(80),
  /** Vertical field of view. */
  fovDeg: num.min(10).max(120).default(40),
  keys: z.array(CameraKey).min(1).max(200),
});

export const PrevizShot = z.object({
  id,
  cameraId: id,
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  /** Actors the shot is about; framing is measured on these. */
  subjectIds: z.array(id).max(8),
  /** The drama shot this previs stands in for, so size and cast can be checked against it. */
  dramaShotId: z.string().min(1).max(120).optional(),
  intendedSize: z.enum(["wide", "medium", "close", "over-shoulder", "insert"]).optional(),
});

export const PrevizDoc = z.object({
  schemaVersion: z.literal(PREVIZ_VERSION),
  id,
  title: z.string().min(1).max(200),
  aspect: z.enum(["16:9", "9:16", "1:1"]),
  fps: z.number().int().min(1).max(120).default(24),
  stage: z.object({ width: Positive, depth: Positive }),
  props: z.array(Prop).max(300),
  actors: z.array(Actor).max(40),
  cameras: z.array(Camera).max(60),
  shots: z.array(PrevizShot).max(300),
}).superRefine((doc, ctx) => {
  const dup = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((value, i) => { if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [kind, i, "id"], message: `duplicate ${kind} id "${value}"` }); seen.add(value); });
  };
  dup("props", doc.props.map(p => p.id));
  dup("actors", doc.actors.map(a => a.id));
  dup("cameras", doc.cameras.map(c => c.id));
  dup("shots", doc.shots.map(s => s.id));
  doc.cameras.forEach((camera, ci) => {
    camera.keys.forEach((key, ki) => {
      if (ki > 0 && key.tMs <= camera.keys[ki - 1]!.tMs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cameras", ci, "keys", ki, "tMs"], message: "camera keys must be strictly increasing in time" });
    });
  });
  const actorIds = new Set(doc.actors.map(a => a.id)), cameraIds = new Set(doc.cameras.map(c => c.id));
  doc.cameras.forEach((camera, ci) => camera.keys.forEach((key, ki) => {
    if ("actorId" in key.target && !actorIds.has(key.target.actorId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cameras", ci, "keys", ki, "target"], message: `unknown actor "${key.target.actorId}"` });
  }));
  doc.shots.forEach((shot, si) => {
    if (!cameraIds.has(shot.cameraId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", si, "cameraId"], message: `unknown camera "${shot.cameraId}"` });
    shot.subjectIds.forEach(subject => { if (!actorIds.has(subject)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", si, "subjectIds"], message: `unknown actor "${subject}"` }); });
    if (shot.endMs <= shot.startMs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shots", si, "endMs"], message: "a shot must end after it starts" });
  });
});

export type Vec3 = z.infer<typeof Vec3>;
export type Prop = z.infer<typeof Prop>;
export type Actor = z.infer<typeof Actor>;
export type Camera = z.infer<typeof Camera>;
export type CameraKey = z.infer<typeof CameraKey>;
export type PrevizShot = z.infer<typeof PrevizShot>;
export type PrevizDoc = z.infer<typeof PrevizDoc>;
export type PrevizDocInput = z.input<typeof PrevizDoc>;
