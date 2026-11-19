import { describe, expect, it } from "vitest";
import {
  actorRadius, aspectRatio, basis, classifySize, CONVENTION, dot, evaluateCamera, exportCamera, exportShotCameras, facing, frameTimes, lintPreviz, measureSubject,
  PrevizDoc, PrevizError, project, suggestCamera, type PrevizDoc as Doc, type PrevizDocInput, type Vec3,
} from "./index";

const base = (): PrevizDocInput => ({
  schemaVersion: 1, id: "scene-1", title: "对峙", aspect: "16:9", fps: 24,
  stage: { width: 10, depth: 10 },
  props: [{ id: "table", name: "桌子", shape: "box", position: [3, 0, 0], size: [1, 0.8, 1], yawDeg: 0 }],
  actors: [
    { id: "ana", name: "安娜", heightM: 1.7, position: [0, 0, -1], yawDeg: 0, pose: "stand" },
    { id: "ben", name: "本", heightM: 1.8, position: [0, 0, 1], yawDeg: 180, pose: "stand" },
  ],
  cameras: [], shots: [],
});

const parse = (input: PrevizDocInput): Doc => PrevizDoc.parse(input);

/** A document whose shots frame the named actor at the named size from a suggested camera. */
function withShots(shots: { id: string; actor: string; size: "wide" | "medium" | "close" | "over-shoulder"; angleDeg?: number; startMs?: number; subjects?: string[]; intended?: "wide" | "medium" | "close" | "over-shoulder" }[], mutate: (doc: PrevizDocInput) => void = () => {}): Doc {
  const draft = parse(base());
  const input = base();
  input.cameras = shots.map(shot => { const s = suggestCamera(draft, { actorId: shot.actor, size: shot.size, angleDeg: shot.angleDeg }); return { id: `cam-${shot.id}`, name: shot.id, fovDeg: s.fovDeg, keys: [{ tMs: 0, position: s.position, target: s.target, easing: "linear" as const }] }; });
  input.shots = shots.map((shot, i) => ({ id: shot.id, cameraId: `cam-${shot.id}`, startMs: shot.startMs ?? i * 2000, endMs: (shot.startMs ?? i * 2000) + 2000, subjectIds: shot.subjects ?? [shot.actor], intendedSize: shot.intended }));
  mutate(input);
  return parse(input);
}

const codes = (doc: Doc) => lintPreviz(doc).map(issue => issue.code);

describe("coordinate convention", () => {
  it("states one convention: right-handed, +Y up, front +Z, metres", () => {
    expect(CONVENTION).toMatchObject({ handedness: "right", up: [0, 1, 0], front: [0, 0, 1], unit: "m" });
  });

  it("yaw 0 faces +Z and positive yaw turns toward +X", () => {
    expect(facing(0)).toEqual([0, 0, 1]);
    expect(facing(90)[0]).toBeCloseTo(1);
    expect(facing(90)[2]).toBeCloseTo(0);
    expect(facing(180)[2]).toBeCloseTo(-1);
  });

  it("builds a right-handed camera basis from look-at", () => {
    const b = basis([0, 0, 5], [0, 0, 0]);
    expect(b.forward).toEqual([0, 0, -1]);
    expect(b.right.map(v => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0]);
    expect(b.up).toEqual([0, 1, 0]);
    const down = basis([0, 5, 0], [0, 0, 0]);
    expect(dot(down.forward, down.right)).toBeCloseTo(0);
    expect(Math.abs(dot(down.right, down.right) - 1)).toBeLessThan(1e-9);
  });

  it("maps aspect names to ratios", () => {
    expect([aspectRatio("16:9"), aspectRatio("9:16"), aspectRatio("1:1")]).toEqual([16 / 9, 9 / 16, 1]);
  });
});

describe("schema", () => {
  it("accepts a valid document and fills defaults", () => {
    const doc = parse(base());
    expect(doc.actors[0]!.pose).toBe("stand");
    expect(doc.fps).toBe(24);
  });

  it("rejects duplicate ids, unsorted keys and broken references", () => {
    const dupActor = base(); dupActor.actors.push({ ...dupActor.actors[0]! });
    expect(PrevizDoc.safeParse(dupActor).success).toBe(false);
    const unsorted = base();
    unsorted.cameras = [{ id: "c", name: "c", keys: [{ tMs: 100, position: [0, 1, 3], target: { point: [0, 1, 0] } }, { tMs: 100, position: [0, 1, 2], target: { point: [0, 1, 0] } }] }];
    expect(PrevizDoc.safeParse(unsorted).error?.issues[0]?.message).toMatch(/strictly increasing/);
    const badTarget = base();
    badTarget.cameras = [{ id: "c", name: "c", keys: [{ tMs: 0, position: [0, 1, 3], target: { actorId: "nobody" } }] }];
    expect(PrevizDoc.safeParse(badTarget).error?.issues[0]?.message).toMatch(/unknown actor/);
    const badShot = base();
    badShot.shots = [{ id: "s", cameraId: "missing", startMs: 500, endMs: 500, subjectIds: ["ghost"] }];
    const messages = PrevizDoc.safeParse(badShot).error?.issues.map(i => i.message).join("|") ?? "";
    expect(messages).toMatch(/unknown camera/);
    expect(messages).toMatch(/unknown actor/);
    expect(messages).toMatch(/end after it starts/);
  });
});

describe("camera evaluation and projection", () => {
  const moving = () => {
    const input = base();
    input.cameras = [{ id: "dolly", name: "推轨", fovDeg: 40, keys: [
      { tMs: 0, position: [0, 1.5, 6], target: { point: [0, 1, 0] }, easing: "linear" },
      { tMs: 1000, position: [0, 1.5, 2], target: { point: [0, 1, 0] }, easing: "linear" },
      { tMs: 2000, position: [0, 1.5, 2], target: { actorId: "ana" }, easing: "ease-in-out" },
    ] }];
    return parse(input);
  };

  it("holds before the first key and after the last", () => {
    const doc = moving();
    expect(evaluateCamera(doc, "dolly", -50).position).toEqual([0, 1.5, 6]);
    expect(evaluateCamera(doc, "dolly", 9999).position).toEqual([0, 1.5, 2]);
  });

  it("interpolates linearly between keys", () => {
    expect(evaluateCamera(moving(), "dolly", 500).position).toEqual([0, 1.5, 4]);
  });

  it("eases in and out when asked", () => {
    const input = base();
    input.cameras = [{ id: "c", name: "c", keys: [{ tMs: 0, position: [0, 1, 0], target: { point: [0, 1, 5] }, easing: "ease-in-out" }, { tMs: 1000, position: [4, 1, 0], target: { point: [0, 1, 5] }, easing: "linear" }] }];
    const doc = parse(input);
    expect(evaluateCamera(doc, "c", 500).position[0]).toBeCloseTo(2);
    expect(evaluateCamera(doc, "c", 250).position[0]).toBeLessThan(1);
  });

  it("aims at an actor's eye height by default and follows an offset", () => {
    const input = base();
    input.cameras = [{ id: "c", name: "c", keys: [{ tMs: 0, position: [0, 1, 4], target: { actorId: "ana" } }, { tMs: 1000, position: [0, 1, 4], target: { actorId: "ana", offset: [0, 0.2, 0] } }] }];
    const doc = parse(input);
    expect(evaluateCamera(doc, "c", 0).target[1]).toBeCloseTo(1.7 * 0.9);
    expect(evaluateCamera(doc, "c", 1000).target[1]).toBeCloseTo(0.2);
  });

  it("reports unknown cameras as PrevizError", () => {
    expect(() => evaluateCamera(parse(base()), "none", 0)).toThrow(PrevizError);
  });

  it("projects the aim point to the frame centre and side points by the lens", () => {
    const state = { position: [0, 0, 5] as Vec3, target: [0, 0, 0] as Vec3, fovDeg: 40 };
    expect(project(state, 1, [0, 0, 0])).toMatchObject({ x: 0, y: 0, inFront: true, depth: 5 });
    expect(project(state, 1, [1, 0, 0]).x).toBeCloseTo(1 / (5 * Math.tan(Math.PI / 9)), 6);
    expect(project(state, 2, [1, 0, 0]).x).toBeCloseTo(0.5 / (5 * Math.tan(Math.PI / 9)), 6);
    expect(project(state, 1, [0, 0, 8]).inFront).toBe(false);
  });
});

describe("measuring and suggesting a frame", () => {
  const doc = parse(base());

  it.each([["wide", 0.5], ["medium", 1.8], ["close", 4.0]] as const)("a suggested %s camera measures about %s of the frame height and classifies back to the same size", (size, target) => {
    const s = suggestCamera(doc, { actorId: "ana", size });
    const state = { position: s.position, target: [0, 1.7 * (size === "wide" ? 0.5 : size === "medium" ? 0.72 : 0.88), -1] as Vec3, fovDeg: s.fovDeg };
    const m = measureSubject(doc, state, doc.actors[0]!);
    expect(m.heightFraction / target).toBeGreaterThan(0.9);
    expect(m.heightFraction / target).toBeLessThan(1.1);
    expect(classifySize(m.heightFraction)).toBe(size);
  });

  it("puts the camera in front of the actor at angle 0 and swings toward +X for positive angles", () => {
    const front = suggestCamera(doc, { actorId: "ana", size: "medium" });
    expect(front.position[0]).toBeCloseTo(0);
    expect(front.position[2]).toBeGreaterThan(-1);
    const side = suggestCamera(doc, { actorId: "ana", size: "medium", angleDeg: 90 });
    expect(side.position[0]).toBeGreaterThan(0.5);
    expect(side.position[2]).toBeCloseTo(-1, 5);
  });

  it("sees a wide shot fully, a close-up partly, and a subject behind the camera not at all", () => {
    const wide = suggestCamera(doc, { actorId: "ana", size: "wide" });
    const m = measureSubject(doc, { position: wide.position, target: [0, 0.85, -1], fovDeg: wide.fovDeg }, doc.actors[0]!);
    expect(m.visible).toBeGreaterThan(0.95);
    expect(m.headInFrame).toBe(true);
    expect(m.headroom).toBeGreaterThan(0);
    const behind = measureSubject(doc, { position: [0, 1.2, -5], target: [0, 1.2, -10], fovDeg: 40 }, doc.actors[0]!);
    expect(behind).toMatchObject({ behindCamera: true, visible: 0 });
  });

  it("derives actor footprint from height", () => {
    expect(actorRadius(doc.actors[0]!)).toBeCloseTo(0.255);
  });
});

describe("derived camera export", () => {
  const doc = withShots([{ id: "s1", actor: "ana", size: "medium" }]);

  it("lists frames at the document frame rate, deterministically", () => {
    const times = frameTimes(doc, "s1");
    expect(times).toHaveLength(48);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(42);
    expect(frameTimes(doc, "s1")).toEqual(times);
    expect(exportShotCameras(doc, "s1")).toHaveLength(48);
  });

  it("gives a view matrix that sends the camera to the origin and the target down −Z", () => {
    const e = exportCamera(doc, "cam-s1", 0);
    const m = e.viewMatrix;
    const apply = (p: Vec3) => [0, 1, 2].map(row => m[row * 4]! * p[0] + m[row * 4 + 1]! * p[1] + m[row * 4 + 2]! * p[2] + m[row * 4 + 3]!);
    apply(e.position).forEach(v => expect(Math.abs(v)).toBeLessThan(1e-9));
    const t = apply(e.target);
    expect(Math.abs(t[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(t[1]!)).toBeLessThan(1e-9);
    expect(t[2]).toBeLessThan(0);
    expect(e.aspect).toBeCloseTo(16 / 9);
  });

  it("reports an unknown shot", () => {
    expect(() => frameTimes(doc, "nope")).toThrow(/Unknown shot/);
  });
});

describe("lintPreviz", () => {
  it("is silent on a well-framed pair of shots", () => {
    expect(lintPreviz(withShots([{ id: "s1", actor: "ana", size: "medium", intended: "medium" }, { id: "s2", actor: "ben", size: "close", intended: "close" }]))).toEqual([]);
  });

  it("flags actors off the stage, inside a prop and overlapping", () => {
    expect(codes(withShots([], d => { d.actors[0]!.position = [6, 0, 0]; }))).toContain("actor-off-stage");
    expect(codes(withShots([], d => { d.actors[0]!.position = [3, 0, 0]; }))).toContain("actor-in-prop");
    expect(codes(withShots([], d => { d.actors[1]!.position = [0.1, 0, -1]; }))).toContain("actor-overlap");
  });

  it("flags a camera inside a prop", () => {
    const doc = withShots([{ id: "s1", actor: "ana", size: "medium" }], d => { d.cameras[0]!.keys[0]!.position = [3, 0.4, 0]; });
    expect(codes(doc)).toContain("camera-inside-prop");
  });

  it("flags a subject outside the frame, behind the camera, or too close", () => {
    const away = withShots([{ id: "s1", actor: "ana", size: "medium" }], d => { d.cameras[0]!.keys[0] = { tMs: 0, position: [0, 1.2, 4], target: { point: [8, 1.2, -1] }, easing: "linear" }; });
    expect(codes(away)).toContain("subject-out-of-frame");
    const behind = withShots([{ id: "s1", actor: "ana", size: "medium" }], d => { d.cameras[0]!.keys[0] = { tMs: 0, position: [0, 1.2, -5], target: { point: [0, 1.2, -10] }, easing: "linear" }; });
    expect(codes(behind)).toContain("subject-behind-camera");
    const close = withShots([{ id: "s1", actor: "ana", size: "medium" }], d => { d.cameras[0]!.keys[0] = { tMs: 0, position: [0, 1, -0.8], target: { point: [0, 1, -3] }, easing: "linear" }; });
    expect(codes(close)).toContain("camera-too-close");
  });

  it("requires the whole body for a wide shot", () => {
    const edge = withShots([{ id: "s1", actor: "ana", size: "wide", intended: "wide" }], d => { d.actors[0]!.position = [0, 0, -1]; const k = d.cameras[0]!.keys[0]!; k.target = { point: [-3, 0.85, -1] }; });
    const issue = lintPreviz(edge).find(i => i.code === "subject-out-of-frame");
    expect(issue?.message).toMatch(/在画面内/);
  });

  it("compares the measured size with the size the drama shot asked for", () => {
    const doc = withShots([{ id: "s1", actor: "ana", size: "medium", intended: "close" }]);
    expect(lintPreviz(doc).find(i => i.code === "size-mismatch")?.message).toContain("实测是「medium」");
    expect(codes(withShots([{ id: "s1", actor: "ana", size: "medium", intended: "over-shoulder" }]))).not.toContain("size-mismatch");
  });

  it("warns about a jump cut and clears it with a wider angle or a change of size", () => {
    expect(codes(withShots([{ id: "s1", actor: "ana", size: "medium" }, { id: "s2", actor: "ana", size: "medium", angleDeg: 10 }]))).toContain("jump-cut");
    expect(codes(withShots([{ id: "s1", actor: "ana", size: "medium" }, { id: "s2", actor: "ana", size: "medium", angleDeg: 60 }]))).not.toContain("jump-cut");
    expect(codes(withShots([{ id: "s1", actor: "ana", size: "medium" }, { id: "s2", actor: "ana", size: "close", angleDeg: 10 }]))).not.toContain("jump-cut");
  });

  it("warns when the camera crosses the line between two actors", () => {
    const cross = withShots([{ id: "s1", actor: "ana", size: "medium", subjects: ["ana", "ben"] }, { id: "s2", actor: "ana", size: "medium", subjects: ["ana", "ben"] }], d => {
      d.cameras[0]!.keys[0] = { tMs: 0, position: [3, 1, 0], target: { point: [0, 1, 0] }, easing: "linear" };
      d.cameras[1]!.keys[0] = { tMs: 0, position: [-3, 1, 0], target: { point: [0, 1, 0] }, easing: "linear" };
    });
    expect(codes(cross)).toContain("axis-cross");
    const same = withShots([{ id: "s1", actor: "ana", size: "medium", subjects: ["ana", "ben"] }, { id: "s2", actor: "ana", size: "medium", subjects: ["ana", "ben"] }], d => {
      d.cameras[0]!.keys[0] = { tMs: 0, position: [3, 1, 0], target: { point: [0, 1, 0] }, easing: "linear" };
      d.cameras[1]!.keys[0] = { tMs: 0, position: [4, 1, 2], target: { point: [0, 1, 0] }, easing: "linear" };
    });
    expect(codes(same)).not.toContain("axis-cross");
  });

  it("samples the whole move, not only the first frame", () => {
    const doc = withShots([{ id: "s1", actor: "ana", size: "medium" }], d => {
      d.cameras[0]!.keys.push({ tMs: 2000, position: [3, 0.4, 0], target: { actorId: "ana" }, easing: "linear" });
    });
    expect(codes(doc)).toContain("camera-inside-prop");
  });
});
