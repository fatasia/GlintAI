import { planAnimatedControlFrame } from "./previz-controls-v2";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parseProject } from "@glintai/scenescript";
import { PrevizDoc, exportCamera, frameTimes } from "../../../packages/previz/src/index";
import { controlHtml, type ControlMode } from "./previz-controls-html";
import { createDirectCapture } from "./direct-browser/index";

export interface ControlOptions {
  shot: string;
  frame: number;
  width?: number;
  near?: number;
  far?: number;
}
const modes: ControlMode[] = ["rgb", "depth", "normal"];

export function planControlFrame(input: unknown, options: ControlOptions) {
  if (
    input &&
    typeof input === "object" &&
    (input as { schemaVersion?: unknown }).schemaVersion === 2
  )
    return planAnimatedControlFrame(input, options, planPrimitiveControlFrame);
  return planPrimitiveControlFrame(input, options);
}
export function planPrimitiveControlFrame(input: unknown, options: ControlOptions) {
  const parsed = PrevizDoc.safeParse(input);
  if (!parsed.success) throw new Error("invalid-previz-document");
  const doc = parsed.data;
  if (doc.actors.length || doc.props.some((p) => p.shape === "model"))
    throw new Error(
      "unsupported-content: only stage and box/cylinder/sphere; actors/models are not rendered",
    );
  const shot = doc.shots.find((s) => s.id === options.shot);
  if (!shot) throw new Error("shot-not-found");
  const count = Math.max(1, Math.round(((shot.endMs - shot.startMs) * doc.fps) / 1000));
  // Bound allocation before calling the shared frame-time function.
  if (count > 432000) throw new Error("shot-too-long");
  if (!Number.isSafeInteger(options.frame) || options.frame < 0 || options.frame >= count)
    throw new Error("frame-out-of-range");
  const [a, b] = doc.aspect.split(":").map(Number) as [number, number];
  const width = options.width ?? 320,
    height = Math.round((width * b) / a);
  if (!Number.isInteger(width) || width < 16 || width > 2048 || height < 16 || height > 2048)
    throw new Error("invalid-resolution");
  const near = options.near ?? 0.1,
    far = options.far ?? 100;
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near || far > 10000)
    throw new Error("invalid-depth-range");
  const tMs = frameTimes(doc, shot.id)[options.frame]! - shot.startMs;
  const camera = exportCamera(doc, shot.cameraId, tMs);
  if (Math.hypot(...camera.forward) < 0.99) throw new Error("degenerate-camera");
  const project = controlProject(doc, camera, near, far);
  return {
    project,
    width,
    height,
    metadata: {
      format: "glint-previz-controls-v1" as const,
      documentId: doc.id,
      shotId: shot.id,
      frame: options.frame,
      absoluteTimeMs: tMs + shot.startMs,
      camera,
      near,
      far,
      width,
      height,
      depth: "RGB8 grayscale: near=255, far=0; background=0; antialiased edges are mixed",
      normal: "view-space XYZ mapped by (n+1)/2 to RGB8; background=0",
      scope: "stage and primitive geometry only",
    },
  };
}

function controlProject(
  doc: PrevizDoc,
  camera: ReturnType<typeof exportCamera>,
  near: number,
  far: number,
) {
  return parseProject({
    schemaVersion: 1,
    id: "previz-controls",
    title: "Geometry controls",
    aspect: doc.aspect,
    fps: doc.fps,
    knowledgeSources: [],
    scenes: modes.map((mode) => ({
      id: mode,
      kind: "html",
      animation: "three",
      html: controlHtml(doc, camera, near, far, mode),
      narration: { text: "Geometry controls", durationMs: 1000 },
    })),
  });
}

/** Derived artifacts only; destination must not exist. */
export async function exportControlFrame(
  input: unknown,
  options: ControlOptions,
  destination: string,
  signal?: AbortSignal,
) {
  const plan = planControlFrame(input, options);
  signal?.throwIfAborted();
  const output = path.resolve(destination);
  await fs.mkdir(output); // Exclusive claim: never reuse a caller-owned directory.
  let scratch: string | undefined,
    capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  const owned: string[] = [];
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "glint-previz-controls-"));
    capture = await createDirectCapture(
      plan.project,
      scratch,
      scratch,
      plan.width,
      plan.height,
      signal,
    );
    const artifacts = await captureModes(capture, plan.project.scenes, output, owned, signal);
    signal?.throwIfAborted();
    const manifest = { ...plan.metadata, artifacts };
    const file = path.join(output, "controls.json"),
      handle = await fs.open(file, "wx");
    owned.push(file);
    try {
      await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n");
    } finally {
      await handle.close();
    }
    return manifest;
  } catch (error) {
    for (const file of owned) await fs.unlink(file).catch(() => undefined);
    await fs.rmdir(output).catch(() => undefined); // Do not remove files created by somebody else.
    throw error;
  } finally {
    await capture?.close();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function captureModes(
  capture: Awaited<ReturnType<typeof createDirectCapture>>,
  scenes: ReturnType<typeof planControlFrame>["project"]["scenes"],
  output: string,
  owned: string[],
  signal?: AbortSignal,
) {
  const artifacts = [];
  for (const scene of scenes) {
    signal?.throwIfAborted();
    const filename = `${scene.id}.png`,
      file = path.join(output, filename);
    const handle = await fs.open(file, "wx");
    await handle.close();
    owned.push(file);
    await capture.load(scene, true);
    await capture.screenshot(0, file);
    const bytes = await fs.readFile(file);
    artifacts.push({
      file: filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return artifacts;
}
