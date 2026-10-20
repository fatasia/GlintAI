import fs from "node:fs/promises";
import path from "node:path";
import {
  gltfExternalResources, isSafeRelativeAssetPath, LocalAssetPath, readGltfDocument,
  type SceneScriptProject,
} from "@glintai/scenescript";

export const PROJECT_ASSET_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFiles: 2048,
  maxDepth: 32,
} as const;
export type AssetLimits = { [K in keyof typeof PROJECT_ASSET_LIMITS]: number };

async function rejectSymlinkComponents(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Asset directory must not be a symlink or non-directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function assetRefs(project: SceneScriptProject): string[] {
  const refs: string[] = [];
  for (const scene of project.scenes) {
    if (scene.kind === "image" || (scene.kind === "three" && scene.model === "gltf")) refs.push(scene.src);
    if (scene.narration.audioRef?.startsWith("assets/")) refs.push(scene.narration.audioRef);
  }
  if (project.music?.src.startsWith("assets/")) refs.push(project.music.src);
  for (const ref of refs) LocalAssetPath.parse(ref);
  return refs;
}

/**
 * Copies projectDir/assets recursively into a fresh publicDir/assets/project-*.
 * Returns a deep copy with asset src/audioRef rewritten; caller must render it.
 * Relative glTF buffer/texture URIs stay unchanged. Failure removes only this run.
 * Generated public/audio references are deliberately left to the audio pipeline.
 */
export async function copyProjectAssets(
  projectDir: string,
  publicDir: string,
  project: SceneScriptProject,
  limits: AssetLimits = PROJECT_ASSET_LIMITS,
): Promise<SceneScriptProject> {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid asset limit ${key}`);
  }
  const prepared = structuredClone(project);
  const refs = assetRefs(prepared);
  const source = path.resolve(projectDir, "assets");
  await rejectSymlinkComponents(source);
  try {
    await fs.access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (refs.length) throw new Error(`Project assets directory is missing: ${source}`);
    return prepared;
  }
  const targetRoot = path.resolve(publicDir, "assets");
  const relativeTarget = path.relative(source, targetRoot);
  if (!relativeTarget || (!relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== ".." && !path.isAbsolute(relativeTarget))) {
    throw new Error("Public assets directory must not be inside project assets");
  }
  await rejectSymlinkComponents(targetRoot);
  await fs.mkdir(targetRoot, { recursive: true });
  const target = await fs.mkdtemp(path.join(targetRoot, "project-"));
  const namespace = `assets/${path.basename(target)}`;
  const files = new Set<string>();
  const portableNames = new Set<string>();
  const dependencies: Array<{ model: string; refs: string[] }> = [];
  let totalBytes = 0;
  let entries = 0;

  const copyDirectory = async (relative: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new Error(`Asset directory depth exceeds ${limits.maxDepth}`);
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      if (++entries > limits.maxFiles) throw new Error(`Asset entry count exceeds ${limits.maxFiles}`);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeRelativeAssetPath(name)) throw new Error(`Unsafe asset filename: ${name}`);
      const portableName = name.toLowerCase();
      if (portableNames.has(portableName)) throw new Error(`Case-colliding asset filename: ${name}`);
      portableNames.add(portableName);
      const input = path.join(source, name);
      const output = path.join(target, name);
      const stat = await fs.lstat(input);
      if (stat.isSymbolicLink()) throw new Error(`Asset symlinks are forbidden: ${name}`);
      if (stat.isDirectory()) {
        await fs.mkdir(output);
        await copyDirectory(name, depth + 1);
      } else if (stat.isFile()) {
        if (stat.size > limits.maxFileBytes) throw new Error(`Asset exceeds per-file byte limit: ${name}`);
        totalBytes += stat.size;
        if (totalBytes > limits.maxTotalBytes) throw new Error("Project assets exceed total byte limit");
        const bytes = await fs.readFile(input);
        if (bytes.length !== stat.size) throw new Error(`Asset changed while copying; retry: ${name}`);
        if (/\.(gltf|glb)$/i.test(name)) {
          dependencies.push({ model: name, refs: gltfExternalResources(readGltfDocument(bytes)) });
        }
        await fs.writeFile(output, bytes, { flag: "wx" });
        files.add(name);
      } else throw new Error(`Asset must be a regular file: ${name}`);
    }
  };

  try {
    await copyDirectory("", 0);
    for (const ref of refs) {
      if (!files.has(ref.slice("assets/".length))) throw new Error(`Project asset is missing: ${ref}`);
    }
    for (const model of dependencies) {
      for (const ref of model.refs) {
        const resource = path.posix.join(path.posix.dirname(model.model), ref);
        if (!files.has(resource)) throw new Error(`glTF resource is missing: ${model.model} -> ${ref}`);
      }
    }
    const rewrite = (src: string) => src.startsWith("assets/") ? `${namespace}/${src.slice(7)}` : src;
    for (const scene of prepared.scenes) {
      if (scene.kind === "image" || (scene.kind === "three" && scene.model === "gltf")) scene.src = rewrite(scene.src);
      if (scene.narration.audioRef) scene.narration.audioRef = rewrite(scene.narration.audioRef);
    }
    if (prepared.music) prepared.music.src = rewrite(prepared.music.src);
    return prepared;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}
