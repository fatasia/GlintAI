import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { captureGltfMorphs } from "../../../packages/video/src/scenes/gltf";
import { runGltfControls } from "./gltf-controls";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(locked = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-gltf-cli-")); roots.push(root);
  fs.mkdirSync(path.join(root, "assets"));
  const source = fileURLToPath(new URL("../../../examples/local-media/assets/models/cube.gltf", import.meta.url));
  const model = JSON.parse(fs.readFileSync(source, "utf8")); model.meshes[0].extras = { targetNames: ["Smile", "Blink"] };
  model.meshes[0].primitives[0].targets = [{ POSITION: 0 }, { POSITION: 0 }];
  fs.writeFileSync(path.join(root, "assets", "model.gltf"), JSON.stringify(model));
  const project = path.join(root, "project.json");
  fs.writeFileSync(project, JSON.stringify({ schemaVersion: 1, id: "model", title: "Model", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "three", model: "gltf", src: "assets/model.gltf", locked, narration: { text: "model" } }] }));
  return { root, project, out: path.join(root, "edited.json") };
}

it("lists names and creates a separate validated project", () => {
  const { project, out } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {}), original = fs.readFileSync(project, "utf8");
  runGltfControls([`--project=${project}`, "--scene=one"]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ clips: ["Turn"], morphTargets: ["Smile", "Blink"] });
  runGltfControls([`--project=${project}`, "--scene=one", "--clip=Turn", "--morph=Smile=0.7", "--morph=Blink=0.2", `--out=${out}`]);
  expect(JSON.parse(fs.readFileSync(out, "utf8")).scenes[0]).toMatchObject({ animationClip: "Turn", morphTargets: { Smile: 0.7, Blink: 0.2 } });
  expect(fs.readFileSync(project, "utf8")).toBe(original);
  expect(() => runGltfControls([`--project=${project}`, "--scene=one", "--clip=Turn", `--out=${out}`])).toThrow();
});
it("refuses unknown names, invalid weights, locked scenes, and output in a different directory", () => {
  const { project, out } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  for (const flag of ["--clip=Missing", "--morph=Missing=0.5", "--morph=Smile=NaN", "--morph=Smile=1.1", "--morph=Smile="]) {
    expect(() => runGltfControls([`--project=${project}`, "--scene=one", flag, `--out=${out}`])).toThrow();
    expect(fs.existsSync(out)).toBe(false);
  }
  expect(() => runGltfControls([`--project=${project}`, "--scene=one", "--clip=Turn", `--out=${path.join(os.tmpdir(), "outside.json")}`])).toThrow(/beside/);
  const locked = fixture(true);
  expect(() => runGltfControls([`--project=${locked.project}`, "--scene=one", "--clip=Turn", `--out=${locked.out}`])).toThrow(/locked/);
});
it("discovers real unnamed targets without turning indexes into editable controls", async () => {
  const { root, project, out } = fixture();
  const modelPath = path.join(root, "assets", "model.gltf");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const source = fileURLToPath(new URL("../../../examples/local-media/assets/models/", import.meta.url));
  const bytes = fs.readFileSync(path.join(source, "cube.bin"));
  const delta = Buffer.alloc(24 * 12);
  const buffer = Buffer.concat([bytes, delta]);
  model.buffers[0] = { uri: `data:application/octet-stream;base64,${buffer.toString("base64")}`, byteLength: buffer.length };
  model.images[0].uri = `data:image/png;base64,${fs.readFileSync(path.join(source, "textures", "checker.png")).toString("base64")}`;
  model.bufferViews.push({ buffer: 0, byteOffset: bytes.length, byteLength: delta.length });
  model.accessors.push({ bufferView: model.bufferViews.length - 1, componentType: 5126, count: 24, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] });
  model.meshes[0].primitives[0].targets = [{ POSITION: model.accessors.length - 1 }];
  delete model.meshes[0].extras;
  fs.writeFileSync(modelPath, JSON.stringify(model));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runGltfControls([`--project=${project}`, "--scene=one"]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ morphTargets: [], unnamedMorphTargets: [{ meshIndex: 0, primitiveIndex: 0, targetIndex: 0, reason: "unnamed" }] });
  expect(() => runGltfControls([`--project=${project}`, "--scene=one", "--morph=0=0.8", `--out=${out}`])).toThrow(/Invalid morph/);
  expect(fs.existsSync(out)).toBe(false);
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("ProgressEvent", class extends Event {});
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close() {} })));
  try {
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify(model), "");
    const mesh = gltf.scene.getObjectByName("AuthoredCube") as import("three").Mesh;
    expect(mesh.morphTargetDictionary).toEqual({ "0": 0 });
    captureGltfMorphs(gltf.scene).apply({ "0": 0.8 });
    expect(mesh.morphTargetInfluences).toEqual([0.8]);
  } finally { vi.unstubAllGlobals(); }
});

it("reports partial and mismatched names per primitive without guessing keys", () => {
  const { root, project, out } = fixture();
  const modelPath = path.join(root, "assets", "model.gltf");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  model.meshes = [
    { extras: { targetNames: ["Named", ""] }, primitives: [{ targets: [{ POSITION: 0 }, { NORMAL: 0 }] }, { targets: [{ COLOR_0: 0 }] }] },
    { primitives: [{ targets: [{ TANGENT: 0 }, {}, null, { POSITION: 0 }] }] },
    { extras: { targetNames: ["Name"] }, primitives: [] },
  ];
  fs.writeFileSync(modelPath, JSON.stringify(model));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runGltfControls([`--project=${project}`, "--scene=one"]);
  const inspected = JSON.parse(String(log.mock.calls[0]![0]));
  expect(inspected.morphTargets).toEqual(["Named"]);
  expect(inspected.unnamedMorphTargets).toEqual([
    { meshIndex: 0, primitiveIndex: 0, targetIndex: 1, reason: "unnamed" },
    { meshIndex: 0, primitiveIndex: 1, targetIndex: 0, reason: "name-count-mismatch" },
    { meshIndex: 1, primitiveIndex: 0, targetIndex: 0, reason: "unnamed" },
    { meshIndex: 1, primitiveIndex: 0, targetIndex: 1, reason: "unnamed" },
    { meshIndex: 1, primitiveIndex: 0, targetIndex: 3, reason: "unnamed" },
  ]);
  expect(() => runGltfControls([`--project=${project}`, "--scene=one", "--morph=0=1", `--out=${out}`])).toThrow(/Invalid morph/);
  expect(() => runGltfControls([`--project=${project}`, "--scene=one", "--morph=Name=1", `--out=${out}`])).toThrow(/Invalid morph/);
  expect(fs.existsSync(out)).toBe(false);
});

it("rejects metadata names when target counts mismatch or no supported targets exist", () => {
  const { root, project, out } = fixture();
  const modelPath = path.join(root, "assets", "model.gltf");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  model.meshes = [
    { extras: { targetNames: ["Mismatch"] }, primitives: [{ targets: [{ POSITION: 0 }, { POSITION: 0 }] }] },
    { extras: { targetNames: ["TangentOnly"] }, primitives: [{ targets: [{ TANGENT: 0 }] }] },
    { extras: { targetNames: ["NoTargets"] }, primitives: [{}] },
  ];
  fs.writeFileSync(modelPath, JSON.stringify(model));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runGltfControls([`--project=${project}`, "--scene=one"]);
  expect(JSON.parse(String(log.mock.calls[0]![0])).morphTargets).toEqual([]);
  for (const name of ["Mismatch", "TangentOnly", "NoTargets"]) {
    expect(() => runGltfControls([`--project=${project}`, "--scene=one", `--morph=${name}=1`, `--out=${out}`])).toThrow(/Invalid morph/);
    expect(fs.existsSync(out)).toBe(false);
  }
});

it("inspects unnamed targets in a GLB document", () => {
  const { root, project } = fixture();
  const modelPath = path.join(root, "assets", "model.gltf");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  delete model.meshes[0].extras;
  model.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
  const json = Buffer.from(JSON.stringify(model));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.write("JSON", 16); padded.copy(glb, 20);
  fs.writeFileSync(modelPath, glb);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runGltfControls([`--project=${project}`, "--scene=one"]);
  expect(JSON.parse(String(log.mock.calls[0]![0])).unnamedMorphTargets).toEqual([{ meshIndex: 0, primitiveIndex: 0, targetIndex: 0, reason: "unnamed" }]);
});

it("reaches the command through the actual CLI without credentials", () => {
  const { project, out } = fixture(), cli = fileURLToPath(new URL("./glint.ts", import.meta.url));
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "gltf-controls", `--project=${project}`, "--scene=one", "--clip=Turn", "--morph=Smile=0.4", `--out=${out}`], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(fs.readFileSync(out, "utf8")).scenes[0].morphTargets).toEqual({ Smile: 0.4 });
});
