import fs from "node:fs";
import path from "node:path";
import { gltfExternalResources, parseProject, readGltfDocument } from "@glintai/scenescript";
import { readArg } from "./glint-runtime";

/** Document-level candidates only: runtime dictionaries and mesh instances can differ. */
function findUnnamedMorphTargets(document: Record<string, unknown>) {
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  return meshes.flatMap((mesh, meshIndex) => {
    if (!mesh || typeof mesh !== "object" || !Array.isArray(mesh.primitives)) return [];
    const names = mesh.extras && typeof mesh.extras === "object" && Array.isArray(mesh.extras.targetNames) ? mesh.extras.targetNames : undefined;
    return mesh.primitives.flatMap((primitive: unknown, primitiveIndex: number) => {
      if (!primitive || typeof primitive !== "object" || !("targets" in primitive) || !Array.isArray(primitive.targets)) return [];
      const targets: unknown[] = primitive.targets;
      const supported = targets.some(target => target && typeof target === "object" && ["POSITION", "NORMAL", "COLOR_0"].some(key => Object.prototype.hasOwnProperty.call(target, key)));
      if (!supported) return [];
      return targets.flatMap((target, targetIndex) => {
        if (!target || typeof target !== "object" || Array.isArray(target)) return [];
        if (names?.length === targets.length && typeof names[targetIndex] === "string" && names[targetIndex]) return [];
        return [{ meshIndex, primitiveIndex, targetIndex, reason: names && names.length !== targets.length ? "name-count-mismatch" : "unnamed" }];
      });
    });
  });
}

function findNamedMorphTargets(document: Record<string, unknown>): string[] {
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const names = new Set<string>();
  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== "object" || !Array.isArray(mesh.primitives) || !Array.isArray(mesh.extras?.targetNames)) continue;
    const targetNames: unknown[] = mesh.extras.targetNames;
    for (const primitive of mesh.primitives) {
      if (!primitive || !Array.isArray(primitive.targets) || primitive.targets.length !== targetNames.length) continue;
      const supported = primitive.targets.some((target: unknown) => target && typeof target === "object" && ["POSITION", "NORMAL", "COLOR_0"].some(key => Object.prototype.hasOwnProperty.call(target, key)));
      if (!supported) continue;
      for (const name of targetNames) if (typeof name === "string" && name) names.add(name);
    }
  }
  return [...names];
}

/** Inspect the source model and write a new project beside it; never overwrite the input. */
export function runGltfControls(args: string[]): void {
  const projectArg = readArg(args, "project"), sceneId = readArg(args, "scene"), outArg = readArg(args, "out");
  if (!projectArg || !sceneId) throw new Error("gltf-controls requires --project=<project.json> --scene=<id>");
  const projectFile = fs.realpathSync(projectArg), directory = path.dirname(projectFile);
  const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene || scene.kind !== "three" || scene.model !== "gltf") throw new Error("Select a glTF scene from the project");
  const modelFile = fs.realpathSync(path.join(directory, scene.src)), relative = path.relative(directory, modelFile);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Model must remain inside the project directory");
  if (fs.statSync(modelFile).size > 64 * 1024 * 1024) throw new Error("Model exceeds 64 MiB inspection limit");
  const document = readGltfDocument(fs.readFileSync(modelFile)); gltfExternalResources(document);
  const clips = (Array.isArray(document.animations) ? document.animations : []).flatMap(item => item && typeof item === "object" && typeof item.name === "string" && item.name ? [item.name] : []);
  const morphNames = findNamedMorphTargets(document);
  const clip = readArg(args, "clip"), clearClip = args.includes("--clear-clip");
  const morphArgs = args.filter(arg => arg.startsWith("--morph=")).map(arg => arg.slice("--morph=".length));
  const removals = args.filter(arg => arg.startsWith("--remove-morph=")).map(arg => arg.slice("--remove-morph=".length));
  const editing = clip !== undefined || clearClip || morphArgs.length > 0 || removals.length > 0;
  if (!editing) {
    if (outArg) throw new Error("No changes requested; omit --out to inspect the model");
    console.log(JSON.stringify({ sceneId, model: scene.src, clips, morphTargets: morphNames, unnamedMorphTargets: findUnnamedMorphTargets(document), current: { animationClip: scene.animationClip ?? null, morphTargets: scene.morphTargets ?? {} }, note: "Unnamed morph candidates are document locations only, not editable control keys. Named metadata is not proof that a target is renderable; no retargeting is performed." }, null, 2));
    return;
  }
  if (scene.locked) throw new Error("Scene is locked; unlock it before editing");
  if (!outArg) throw new Error("Pass --out=<new project.json> beside the input project");
  if (clip !== undefined && clearClip) throw new Error("Choose either --clip or --clear-clip");
  if (clip !== undefined && clips.filter(name => name === clip).length !== 1) throw new Error("Clip must match exactly one named animation in the model");
  if (clip !== undefined) scene.animationClip = clip;
  if (clearClip) delete scene.animationClip;
  const morphs = new Map(Object.entries(scene.morphTargets ?? {}));
  for (const name of removals) { if (!morphs.delete(name)) throw new Error(`Morph override not found: ${name}`); }
  for (const arg of morphArgs) {
    const index = arg.lastIndexOf("="), name = arg.slice(0, index), raw = arg.slice(index + 1), value = Number(raw);
    if (index <= 0 || !raw.trim() || !morphNames.includes(name) || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid morph override: ${arg}`);
    morphs.set(name, value);
  }
  scene.morphTargets = morphs.size ? Object.fromEntries(morphs) : undefined;
  const validated = parseProject(project), output = path.resolve(outArg);
  if (fs.realpathSync(path.dirname(output)) !== directory) throw new Error("Output must be beside the input project so relative assets remain valid");
  fs.writeFileSync(output, JSON.stringify(validated, null, 2) + "\n", { flag: "wx" });
  console.log(`[glint] glTF controls saved: ${output}`);
}
