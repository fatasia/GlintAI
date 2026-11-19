import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AnimationMixer, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, expect, it, vi } from "vitest";
import { retargetGltf } from "./gltf-retarget";

// Synthetic two-joint skeletons for loader verification only, not human models.
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  vi.stubGlobal("ProgressEvent", class extends Event {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-retarget-")); dirs.push(dir);
  const bytes = Buffer.alloc(272); [0, 1, 0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2].forEach((x, i) => bytes.writeFloatLE(x, i * 4));
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((x, i) => bytes.writeFloatLE(x, 40 + i * 4));
  for (let i = 0; i < 3; i++) { bytes[76 + i * 4] = 1; bytes.writeFloatLE(1, 88 + i * 16); }
  for (let matrix = 0; matrix < 2; matrix++) for (let i = 0; i < 4; i++) bytes.writeFloatLE(1, 136 + matrix * 64 + i * 20);
  bytes.writeFloatLE(-1, 136 + 64 + 13 * 4);
  const make = (prefix: string, animated: boolean) => ({
    asset: { version: "2.0", generator: "synthetic non-human two-joint test fixture" },
    scene: 0, scenes: [{ nodes: [0, 2] }], nodes: [{ name: `${prefix}Root`, children: [1] }, { name: `${prefix}Child`, translation: [0, 1, 0] }, { name: `${prefix}Mesh`, mesh: 0, skin: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 2, JOINTS_0: 3, WEIGHTS_0: 4 } }] }],
    skins: [{ joints: [0, 1], inverseBindMatrices: 5 }], buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 32 }, { buffer: 0, byteOffset: 40, byteLength: 36 }, { buffer: 0, byteOffset: 76, byteLength: 12 }, { buffer: 0, byteOffset: 88, byteLength: 48 }, { buffer: 0, byteOffset: 136, byteLength: 128 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] }, { bufferView: 1, componentType: 5126, count: 2, type: "VEC4" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 3, componentType: 5121, count: 3, type: "VEC4" }, { bufferView: 4, componentType: 5126, count: 3, type: "VEC4" }, { bufferView: 5, componentType: 5126, count: 2, type: "MAT4" }],
    ...(animated ? { animations: [{ name: "Turn", samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }] }] } : {})
  });
  const source = path.join(dir, "source.gltf"), target = path.join(dir, "target.gltf"), mapping = path.join(dir, "mapping.json"), out = path.join(dir, "out.gltf");
  const src = make("Source", true), dst = make("Target", false); const map = [{ source: 0, target: 0 }, { source: 1, target: 1 }];
  const save = () => { fs.writeFileSync(source, JSON.stringify(src)); fs.writeFileSync(target, JSON.stringify(dst)); fs.writeFileSync(mapping, JSON.stringify(map)); }; save();
  return { dir, source, target, mapping, out, src, dst, map, save, run: () => retargetGltf(source, target, mapping, 0, out) };
}

it("retargets into a new glTF, loading and sampling both skeletons with GLTFLoader", async () => {
  const f = fixture(), before = [f.source, f.target, f.mapping].map(p => fs.readFileSync(p));
  await f.run();
  expect([f.source, f.target, f.mapping].map(p => fs.readFileSync(p))).toEqual(before);
  const loader = new GLTFLoader(), src = await loader.parseAsync(fs.readFileSync(f.source, "utf8"), ""), dst = await loader.parseAsync(fs.readFileSync(f.out, "utf8"), "");
  expect(dst.animations[0]!.tracks[0]!.name).toContain("TargetChild.quaternion");
  const mesh = dst.scene.getObjectByName("TargetMesh") as import("three").SkinnedMesh;
  expect(mesh.isSkinnedMesh).toBe(true); expect(mesh.skeleton.bones.map(bone => bone.name)).toEqual(["TargetRoot", "TargetChild"]);
  const a = new AnimationMixer(src.scene), b = new AnimationMixer(dst.scene); a.clipAction(src.animations[0]!).play(); b.clipAction(dst.animations[0]!).play();
  for (const t of [0.25, 0.75, 0.25, 0]) {
    a.setTime(t); b.setTime(t);
    const q = src.scene.getObjectByName("SourceChild")!.quaternion, r = dst.scene.getObjectByName("TargetChild")!.quaternion;
    expect(q.x).toBeCloseTo(r.x, 7); expect(q.y).toBeCloseTo(r.y, 7); expect(q.z).toBeCloseTo(r.z, 7); expect(q.w).toBeCloseTo(r.w, 7);
    if (t === 0.75) {
      expect(Math.abs(r.z)).toBeGreaterThan(0.4);
      const sourceMesh = src.scene.getObjectByName("SourceMesh") as import("three").SkinnedMesh;
      src.scene.updateMatrixWorld(true); dst.scene.updateMatrixWorld(true);
      const p = sourceMesh.applyBoneTransform(1, new Vector3().fromBufferAttribute(sourceMesh.geometry.attributes.position!, 1));
      const d = mesh.applyBoneTransform(1, new Vector3().fromBufferAttribute(mesh.geometry.attributes.position!, 1));
      expect(p.distanceTo(d)).toBeLessThan(1e-6); expect(d.distanceTo(new Vector3(1, 0, 0))).toBeGreaterThan(0.5);
    }
  }
  await expect(f.run()).rejects.toThrow();
  expect([f.source, f.target, f.mapping].map(p => fs.readFileSync(p))).toEqual(before);
});

it("copies mapped translation and rotation, including root motion, with deterministic seeks", async () => {
  const f = fixture();
  const bytes = Buffer.from(f.src.buffers[0]!.uri.split(",")[1]!, "base64");
  const translations = Buffer.alloc(24);
  [0, 0, 0, 2, 0, 0].forEach((value, i) => translations.writeFloatLE(value, i * 4));
  const combined = Buffer.concat([bytes, translations]);
  f.src.buffers[0] = { byteLength: combined.length, uri: `data:application/octet-stream;base64,${combined.toString("base64")}` };
  f.src.bufferViews.push({ buffer: 0, byteOffset: bytes.length, byteLength: translations.length });
  f.src.accessors.push({ bufferView: 6, componentType: 5126, count: 2, type: "VEC3" } as any);
  const animation = f.src.animations![0]!;
  animation.samplers.push({ input: 0, output: 6, interpolation: "LINEAR" });
  animation.channels.push({ sampler: 1, target: { node: 0, path: "translation" } });
  f.save();
  await f.run();
  const loader = new GLTFLoader();
  const source = await loader.parseAsync(fs.readFileSync(f.source, "utf8"), "");
  const target = await loader.parseAsync(fs.readFileSync(f.out, "utf8"), "");
  const a = new AnimationMixer(source.scene), b = new AnimationMixer(target.scene);
  a.clipAction(source.animations[0]!).play(); b.clipAction(target.animations[0]!).play();
  for (const t of [0.75, 0.25, 0.75, 0]) {
    a.setTime(t); b.setTime(t);
    const p = source.scene.getObjectByName("SourceRoot")!.position;
    const q = target.scene.getObjectByName("TargetRoot")!.position;
    expect(p.x).toBeCloseTo(2 * t, 6);
    expect(q.distanceTo(p)).toBeLessThan(1e-6);
    expect(target.scene.getObjectByName("TargetChild")!.quaternion.z).toBeCloseTo(source.scene.getObjectByName("SourceChild")!.quaternion.z, 6);
  }
});

it("preserves STEP translation and rejects non-finite translation without creating output", async () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    const bytes = Buffer.from(f.src.buffers[0]!.uri.split(",")[1]!, "base64"), values = Buffer.alloc(24);
    [0, 0, 0, invalid ? NaN : 2, 0, 0].forEach((value, i) => values.writeFloatLE(value, i * 4));
    const combined = Buffer.concat([bytes, values]);
    f.src.buffers[0] = { byteLength: combined.length, uri: `data:application/octet-stream;base64,${combined.toString("base64")}` };
    f.src.bufferViews.push({ buffer: 0, byteOffset: bytes.length, byteLength: values.length });
    f.src.accessors.push({ bufferView: 6, componentType: 5126, count: 2, type: "VEC3" } as any);
    f.src.animations![0]!.samplers[0] = { input: 0, output: 6, interpolation: "STEP" };
    f.src.animations![0]!.channels[0]!.target = { node: 0, path: "translation" };
    f.save();
    if (invalid) { await expect(f.run()).rejects.toThrow(/non-finite/); expect(fs.existsSync(f.out)).toBe(false); continue; }
    await f.run();
    const gltf = await new GLTFLoader().parseAsync(fs.readFileSync(f.out, "utf8"), "");
    const mixer = new AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]!).play(); mixer.setTime(0.75);
    expect(gltf.scene.getObjectByName("TargetRoot")!.position.x).toBe(0);
  }
});

it("preserves STEP interpolation and explicit node-index remapping", async () => {
  const f = fixture();
  f.src.animations![0]!.samplers[0]!.interpolation = "STEP";
  const root = f.dst.nodes[0]!, child = f.dst.nodes[1]!;
  root.children = [0]; f.dst.nodes[0] = child; f.dst.nodes[1] = root;
  f.dst.scenes[0]!.nodes = [1, 2]; f.dst.skins[0]!.joints = [1, 0];
  f.map[0]!.target = 1; f.map[1]!.target = 0; f.save();
  await f.run();
  const result = await new GLTFLoader().parseAsync(fs.readFileSync(f.out, "utf8"), "");
  const mixer = new AnimationMixer(result.scene); mixer.clipAction(result.animations[0]!).play(); mixer.setTime(0.75);
  expect(result.scene.getObjectByName("TargetChild")!.quaternion.z).toBeCloseTo(0, 7);
  expect(JSON.parse(fs.readFileSync(f.out, "utf8")).animations[0].samplers[0].interpolation).toBe("STEP");
});

it("refuses unsupported poses, hierarchy, mappings, channels, interpolation and corrupt data without output", async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.map.pop(); }, f => { f.map[1]!.target = 0; },
    f => { f.dst.nodes[0]!.children = []; }, f => { f.dst.nodes[1]!.translation = [0, 2, 0]; },
    f => { (f.dst.nodes[1] as any).scale = [2, 1, 1]; },
    f => { f.src.animations![0]!.channels[0]!.target.path = "scale"; },
    f => { f.src.animations![0]!.channels[0]!.target.path = "weights"; },
    f => { f.src.animations![0]!.channels[0]!.target.path = "translation"; }, // VEC4 is not a translation output.
    f => { f.src.animations![0]!.channels.push({ ...f.src.animations![0]!.channels[0]! }); },
    f => { f.src.animations![0]!.samplers[0]!.interpolation = "CUBICSPLINE"; },
    f => { f.src.accessors[1]!.count = 3; }, f => { f.src.buffers[0]!.uri = "external.bin"; },
    f => { (f.src as any).extensionsUsed = ["KHR_test"]; },
    f => { f.dst.nodes[1]!.name = f.dst.nodes[0]!.name; },
    f => { f.dst.skins[0]!.inverseBindMatrices = 1; },
    f => { (f.dst.nodes[2] as any).translation = [1, 0, 0]; },
    f => { f.src.animations![0]!.channels[0]!.target.node = 2; },
    f => { f.src.accessors[0]!.count = 1; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); f.save(); await expect(f.run()).rejects.toThrow(); expect(fs.existsSync(f.out)).toBe(false); }
});

it("exercises the standalone CLI and protects existing files", () => {
  const f = fixture(), cli = fileURLToPath(new URL("./gltf-retarget-cli.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const args = [`--source=${f.source}`, `--target=${f.target}`, `--mapping=${f.mapping}`, "--clip-index=0", `--out=${f.target}`];
  const before = fs.readFileSync(f.target), run = (flags: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, ...flags], { encoding: "utf8", timeout: 30000 });
  const fail = run(args); expect(fail.status).not.toBe(0); expect(fs.readFileSync(f.target)).toEqual(before);
  const success = run([...args.slice(0, -1), `--out=${f.out}`]); expect(success.status, success.stderr).toBe(0); expect(fs.existsSync(f.out)).toBe(true);
  expect(run([...args.slice(0, -1), `--out=${f.out}`]).status).not.toBe(0);
});
