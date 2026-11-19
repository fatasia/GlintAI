import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { parseProject } from "@glintai/scenescript";
import { expect, it } from "vitest";
import { findSystemBrowser } from "./direct-browser/host";
import { runGltfControls } from "./gltf-controls";
import { createDirectCapture } from "./direct-browser";

// Real GLTFLoader + WebGL + Remotion pixels. Explicit opt-in; no paid service.
it.skipIf(process.env.GLINT_GLTF_E2E !== "1")("renders the selected animation and morph override into distinct pixels", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-gltf-controls-"));
  const models = path.join(root, "public", "assets", "models"); fs.mkdirSync(path.join(models, "textures"), { recursive: true });
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
  const scene = { id: "cube", kind: "three", model: "gltf", src: "assets/models/cube.gltf", animationClip: "Turn", morphTargets: { Wide: 0 }, narration: { text: "模型", durationMs: 1000 } };
  const project = parseProject({ schemaVersion: 1, id: "gltf-controls", title: "Controls", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [scene] });
  const projectFile = path.join(root, "public", "project.json"); fs.writeFileSync(projectFile, JSON.stringify(project));
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    const serveUrl = await bundle({ entryPoint: path.join(repo, "apps/studio/src/index.ts"), publicDir: path.join(root, "public") });
    browser = await openBrowser("chrome", { browserExecutable: findSystemBrowser() });
    let count = 0;
    const render = async (animationClip: string, weight: number) => {
      const output = path.join(root, "public", `edit-${count++}.json`);
      runGltfControls([`--project=${projectFile}`, "--scene=cube", `--clip=${animationClip}`, `--morph=Wide=${weight}`, `--out=${output}`]);
      const next = parseProject(JSON.parse(fs.readFileSync(output, "utf8")));
      const inputProps = { project: next }, composition = await selectComposition({ serveUrl, id: "Glint", inputProps, puppeteerInstance: browser });
      const still = await renderStill({ serveUrl, composition, inputProps, puppeteerInstance: browser, frame: 15, scale: 0.25, imageFormat: "png" });
      if (!still.buffer) throw new Error("missing rendered pixels");
      return still.buffer;
    };
    const turn = await render("Turn", 0), wide = await render("Turn", 1), still = await render("Still", 0), repeat = await render("Turn", 0);
    const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
    const pixels = (file: string) => {
      const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 480 * 270 * 3 + 1024 });
      if (result.status !== 0 || result.stdout.length !== 480 * 270 * 3) throw new Error("Could not decode rendered frame");
      return result.stdout;
    };
    expect(hash(wide)).not.toBe(hash(turn)); expect(hash(still)).not.toBe(hash(turn)); expect(hash(repeat)).toBe(hash(turn));
    const direct = async (animationClip: string, weight: number, tag: string) => {
      const current = parseProject({ ...project, scenes: [{ ...scene, animationClip, morphTargets: { Wide: weight } }] });
      const capture = await createDirectCapture(current, path.join(root, "public"), path.join(root, `capture-${tag}`), 480, 270);
      try {
        await capture.load(current.scenes[0]!);
        const a = path.join(root, `${tag}.png`), b = path.join(root, `${tag}-repeat.png`);
        await capture.screenshot(15, a); await capture.screenshot(3, b);
        if (process.env.GLINT_GLTF_EVIDENCE) fs.copyFileSync(b, path.join(process.env.GLINT_GLTF_EVIDENCE, `${tag}-frame3.png`));
        await capture.screenshot(15, b);
        if (process.env.GLINT_GLTF_EVIDENCE) { fs.copyFileSync(a, path.join(process.env.GLINT_GLTF_EVIDENCE, `${tag}-a.png`)); fs.copyFileSync(b, path.join(process.env.GLINT_GLTF_EVIDENCE, `${tag}-b.png`)); }
        const first = pixels(a), second = pixels(b);
        let maxDifference = 0; for (let i = 0; i < first.length; i++) maxDifference = Math.max(maxDifference, Math.abs(first[i]! - second[i]!));
        expect(maxDifference).toBeLessThanOrEqual(2); // one-level GPU raster variation is not a changed pose
        return fs.readFileSync(a);
      } finally { await capture.close(); }
    };
    const directTurn = await direct("Turn", 0, "direct-turn"), directWide = await direct("Turn", 1, "direct-wide"), directStill = await direct("Still", 0, "direct-still");
    expect(hash(directWide)).not.toBe(hash(directTurn)); expect(hash(directStill)).not.toBe(hash(directTurn));
    if (process.env.GLINT_GLTF_EVIDENCE) for (const [name, image] of [["direct-turn", directTurn], ["direct-wide", directWide], ["direct-still", directStill]] as const) fs.writeFileSync(path.join(process.env.GLINT_GLTF_EVIDENCE, `${name}.png`), image);
    if (process.env.GLINT_GLTF_EVIDENCE) for (const [name, image] of [["turn", turn], ["wide", wide], ["still", still]] as const) fs.writeFileSync(path.join(process.env.GLINT_GLTF_EVIDENCE, `${name}.png`), image);
  } finally { await browser?.close({ silent: true }); fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000);
