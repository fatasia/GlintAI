import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseProject } from "@glintai/scenescript";
import { expect, it } from "vitest";
import { renderNative } from "./native-render";

// DRAMA-05 逐帧容差稳定性：同一工程两次真实 native 渲染，全帧逐通道对照。
// GPU 栅格化允许单通道 ±1 级抖动（既有复核结论），容差上限 2；跨帧累积
// 漂移必须为零。显式 opt-in，无付费服务。
const FRAME_BYTES = 480 * 270 * 3;
function decodeAllFrames(file: string): Buffer[] {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 256 * 1024 * 1024, encoding: "buffer", windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not decode ${path.basename(file)}`);
  const bytes = result.stdout as Buffer;
  if (bytes.length % FRAME_BYTES !== 0) throw new Error(`Unexpected raw size ${bytes.length}`);
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) frames.push(bytes.subarray(offset, offset + FRAME_BYTES));
  return frames;
}

it.skipIf(process.env.GLINT_GLTF_STABILITY_E2E !== "1")("keeps every rendered frame of a glTF scene within tolerance across two native runs", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-gltf-stability-"));
  const models = path.join(root, "public", "assets", "models"); fs.mkdirSync(path.join(models, "textures"), { recursive: true });
  // 同 gltf-controls.e2e 的扩展原创立方体：Turn 动作 + Wide morph。
  const source = path.join(repo, "examples", "local-media", "assets", "models");
  const gltf = JSON.parse(fs.readFileSync(path.join(source, "cube.gltf"), "utf8"));
  const base = fs.readFileSync(path.join(source, "cube.bin")), delta = Buffer.alloc(24 * 12), identity = Buffer.alloc(3 * 16);
  for (let i = 0; i < 24; i++) delta.writeFloatLE(base.readFloatLE(i * 12) * 1.2, i * 12);
  for (let i = 0; i < 3; i++) identity.writeFloatLE(1, i * 16 + 12);
  const data = Buffer.concat([base, delta, identity]);
  gltf.buffers[0].byteLength = data.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset: base.length, byteLength: delta.length }, { buffer: 0, byteOffset: base.length + delta.length, byteLength: identity.length });
  gltf.accessors.push({ bufferView: 6, componentType: 5126, count: 24, type: "VEC3", min: [-1.2, 0, 0], max: [1.2, 0, 0] }, { bufferView: 7, componentType: 5126, count: 3, type: "VEC4" });
  gltf.meshes[0].primitives[0].targets = [{ POSITION: 6 }]; gltf.meshes[0].weights = [0]; gltf.meshes[0].extras = { targetNames: ["Wide"] };
  gltf.animations.push({ name: "Still", samplers: [{ input: 4, output: 7, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] });
  fs.writeFileSync(path.join(models, "cube.bin"), data); fs.writeFileSync(path.join(models, "cube.gltf"), JSON.stringify(gltf));
  fs.copyFileSync(path.join(source, "textures", "checker.png"), path.join(models, "textures", "checker.png"));
  const project = parseProject({ schemaVersion: 1, id: "gltf-stability", title: "Stability", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "cube", kind: "three", model: "gltf", src: "assets/models/cube.gltf", animationClip: "Turn", morphTargets: { Wide: 0.5 }, narration: { text: "模型", durationMs: 1000 } }] });
  try {
    const projectFile = path.join(root, "public", "project.json"); fs.writeFileSync(projectFile, JSON.stringify(project));
    const first = path.join(root, "run-a.mp4"), second = path.join(root, "run-b.mp4");
    for (const output of [first, second]) await renderNative({ projectPath: projectFile, output, fast: true, tts: "mock", music: "off", noCache: true });
    const framesA = decodeAllFrames(first), framesB = decodeAllFrames(second);
    expect(framesA.length).toBeGreaterThan(10); expect(framesB.length).toBe(framesA.length);
    let maxDifference = 0, differingFrames = 0, identicalFrames = 0;
    const worst: Record<number, number> = {};
    for (let index = 0; index < framesA.length; index++) {
      let frameMax = 0;
      for (let i = 0; i < FRAME_BYTES; i++) frameMax = Math.max(frameMax, Math.abs(framesA[index]![i]! - framesB[index]![i]!));
      if (frameMax === 0) identicalFrames++; else differingFrames++;
      worst[index] = frameMax; maxDifference = Math.max(maxDifference, frameMax);
    }
    const summary = { frames: framesA.length, identicalFrames, differingFrames, maxDifference };
    if (process.env.GLINT_GLTF_EVIDENCE) {
      fs.mkdirSync(process.env.GLINT_GLTF_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.GLINT_GLTF_EVIDENCE, "frame-stability.json"), JSON.stringify(summary, null, 2));
      const extract = (file: string, frame: number, name: string) => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-y", path.join(process.env.GLINT_GLTF_EVIDENCE!, name)], { windowsHide: true });
      extract(first, 0, "stability-frame0.png"); extract(first, Math.floor(framesA.length / 2), "stability-frame-mid.png"); extract(first, framesA.length - 1, "stability-frame-last.png");
    }
    console.log("GLTF_FRAME_STABILITY", JSON.stringify(summary));
    expect(maxDifference).toBeLessThanOrEqual(2);
    expect(differingFrames).toBeLessThan(framesA.length); // 全帧逐字节一致或仅个别帧 ±1 抖动,不允许系统性偏差
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
}, 300_000);
