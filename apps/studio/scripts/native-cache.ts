import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROJECT_ASSET_LIMITS } from "./assets";
import { isSafeRelativeAssetPath } from "@glintai/scenescript";
import { createRequire } from "node:module";
import type { Scene, SceneScriptProject } from "@glintai/scenescript";
import { resolveMediaPath } from "./native-process";
import { browserIdentity } from "./direct-browser/host";

export const fingerprintBytes = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Hash file contents, not just names: replacing a reference image must invalidate its scene. */
export function assetFingerprint(projectDir: string): string {
  const root = path.resolve(projectDir, "assets");
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Asset directory must not be a symlink or non-directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "no-assets";
      throw error;
    }
  }
  const files: { path: string; sha256: string }[] = [];
  const names = new Set<string>();
  let entries = 0, totalBytes = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > PROJECT_ASSET_LIMITS.maxDepth) throw new Error(`Asset directory depth exceeds ${PROJECT_ASSET_LIMITS.maxDepth}`);
    for (const name of fs.readdirSync(directory).sort()) {
      if (++entries > PROJECT_ASSET_LIMITS.maxFiles) throw new Error(`Asset entry count exceeds ${PROJECT_ASSET_LIMITS.maxFiles}`);
      const file = path.join(directory, name), relative = path.relative(root, file).split(path.sep).join("/");
      if (!isSafeRelativeAssetPath(relative)) throw new Error(`Unsafe asset filename: ${relative}`);
      if (names.has(relative.toLowerCase())) throw new Error(`Case-colliding asset filename: ${relative}`);
      names.add(relative.toLowerCase());
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Asset symlinks are forbidden: ${relative}`);
      if (stat.isDirectory()) visit(file, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > PROJECT_ASSET_LIMITS.maxFileBytes) throw new Error(`Asset exceeds per-file byte limit: ${relative}`);
        totalBytes += stat.size;
        if (totalBytes > PROJECT_ASSET_LIMITS.maxTotalBytes) throw new Error("Project assets exceed total byte limit");
        const bytes = fs.readFileSync(file);
        if (bytes.length !== stat.size) throw new Error(`Asset changed while hashing; retry: ${relative}`);
        files.push({ path: relative, sha256: fingerprintBytes(bytes) });
      } else throw new Error(`Asset must be a regular file: ${relative}`);
    }
  };
  visit(root, 0);
  return fingerprintBytes(JSON.stringify(files));
}

export function sceneMediaFingerprint(scene: Scene, root: string, assets: string): string | undefined {
  if (scene.kind === "image" || scene.kind === "video") return fingerprintBytes(fs.readFileSync(resolveMediaPath(root, scene.src)));
  if (scene.kind === "three" && scene.model === "gltf" || scene.kind === "html") return assets;
  return undefined;
}

/**
 * Everything that can change pixels without touching the project file.
 * Kept in one place so the builder and the renderer cannot disagree.
 */
export const IMPLEMENTATION_FILES = [
  "native-render.ts",
  "native-stitch.ts",
  "native-cache.ts",
  "native-process.ts",
  "native-audio.ts",
  "assets.ts",
  "decoders.ts",
  "../../../packages/scenescript/src/index.ts",
  "../../../packages/scenescript/src/frame-rate.ts",
  "../../../packages/scenescript/src/timing.ts",
  "../../../packages/scenescript/src/timeline.ts",
  "../../../packages/scenescript/src/parse.ts",
  "../../../packages/scenescript/src/types.ts",
  "../../../packages/scenescript/src/assets.ts",
  "native-svg/text.ts",
  "native-svg/charts.ts",
  "native-svg/index.ts",
  "native-svg/outline.ts",
  "direct-browser/host.ts",
  "direct-browser/index.ts",
  "direct-browser/page.ts",
  "../../../packages/scenescript/src/motion.ts",
  "../../../packages/scenescript/src/elements.ts",
  "../../../packages/scenescript/src/stroke-path.ts",
  "../../../packages/scenescript/src/effects.ts",
  "../../../packages/design-tokens/src/index.ts",
  // The browser runtime renders HTML scenes; editing it changes pixels too.
  "../../../packages/video/src/scenes/html-runtime.ts",
  "../../../packages/video/src/scenes/html-policy.ts",
  "../../../packages/video/src/scenes/gltf.ts",
  "../../../packages/video/src/scenes/image-layout.ts",
];

export function renderImplementationFingerprint(scriptDir: string): string {
  const resolved = IMPLEMENTATION_FILES.map(file => [file, path.resolve(scriptDir, file)] as const);
  if (resolved.some(([, file]) => !fs.existsSync(file))) {
    // A complete packaged bundle is identifiable by its own bytes, not a default build label.
    const bundle = fileURLToPath(import.meta.url);
    const harness = process.env.GLINT_DIRECT_BROWSER_HARNESS;
    if (/\.mjs$/i.test(bundle) && fs.existsSync(bundle) && (!harness || fs.existsSync(harness))) {
      return fingerprintBytes(JSON.stringify({ bundle: fingerprintBytes(fs.readFileSync(bundle)), harness: harness ? fingerprintBytes(fs.readFileSync(harness)) : null }));
    }
    // Incomplete source cannot safely share a cache, even within this process.
    return `unverified:${randomUUID()}`;
  }
  if (process.env.GLINT_DIRECT_BROWSER_HARNESS) {
    try { return fingerprintBytes(JSON.stringify({ sources: resolved.map(([file, pathname]) => [file, fingerprintBytes(fs.readFileSync(pathname))]), harness: fileContentIdentity(process.env.GLINT_DIRECT_BROWSER_HARNESS) })); }
    catch { return `unverified:${randomUUID()}`; }
  }
  return fingerprintBytes(JSON.stringify(resolved.map(([file, pathname]) => [file, fingerprintBytes(fs.readFileSync(pathname))])));
}

/** Version of an installed package, read from its manifest (cache keys must never hard-code it). */
export function packageVersion(name: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    let directory = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 8; depth++) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        if (parsed.name === name) return parsed.version;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Optional: callers fall back to "unknown", which still invalidates across changes. */ }
  return undefined;
}

const SYSTEM_FONT_DIRS: Record<string, string[]> = {
  win32: [path.join(process.env.WINDIR ?? "C:/Windows", "Fonts")],
  darwin: ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library/Fonts")],
  linux: ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".local/share/fonts"), path.join(os.homedir(), ".fonts")],
};

/**
 * Explicit SVG font files are identified by their bytes; system fonts remain a
 * bounded inventory and do not guarantee browser or cross-machine equivalence.
 */
export function fontFingerprint(files: readonly string[], options: { systemFonts: boolean }): unknown {
  if (files.length) return { mode: "explicit-svg-files", files: files.map(file => ({ name: path.basename(file), sha256: fingerprintBytes(fs.readFileSync(file)) })) };
  if (!options.systemFonts) return { mode: "none" };
  const roots = SYSTEM_FONT_DIRS[process.platform] ?? [];
  const entries: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (entries.length > 4000 || depth > 2) return;
    let names: string[];
    try { names = fs.readdirSync(directory); } catch { return; }
    for (const name of names.sort()) {
      const file = path.join(directory, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile() && /\.(ttf|ttc|otf)$/i.test(name)) entries.push(`${path.relative(directory, file)}:${stat.size}`);
      if (entries.length > 4000) return;
    }
  };
  for (const root of roots) walk(root, 0);
  return { mode: "system", platform: process.platform, count: entries.length, digest: fingerprintBytes(entries.sort().join("\n")) };
}

export interface NativeCacheEnvironment {
  renderer: number;
  platform: string;
  resvg: string;
  browser: string;
  ffmpeg: string;
  sourceFingerprint: string;
  fontIdentity: unknown;
}

export function fileContentIdentity(file: string): string {
  const hash = createHash("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

/** Resolve the executable as invoked by the renderer and hash its bytes. */
export function ffmpegIdentity(): string | undefined {
  try {
    const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8", windowsHide: true });
    const file = lookup.status === 0 ? lookup.stdout.split(/\r?\n/).find(line => line.trim())?.trim() : undefined;
    return file ? fileContentIdentity(file) : undefined;
  } catch { return undefined; }
}

/** One immutable description of the host that rendered a frame. */
export function nativeCacheEnvironment(scriptDir: string, options: { browserRequired: boolean; fontFiles: readonly string[] }): NativeCacheEnvironment {
  return {
    renderer: 2,
    platform: process.platform,
    resvg: packageVersion("@resvg/resvg-js") ?? `unverified:${randomUUID()}`,
    browser: options.browserRequired ? browserIdentity() ?? `unverified:${randomUUID()}` : "none",
    ffmpeg: ffmpegIdentity() || `unverified:${randomUUID()}`,
    sourceFingerprint: renderImplementationFingerprint(scriptDir),
    fontIdentity: fontFingerprint(options.fontFiles, { systemFonts: options.fontFiles.length === 0 }),
  };
}

/** Asset identities resolved for one scene; only its own refs can invalidate it. */
export function sceneAssetFingerprint(project: Pick<SceneScriptProject, "assets">, scene: Scene): string {
  const refs = (scene as { assetRefs?: { assetId: string; version: string }[] }).assetRefs ?? [];
  return fingerprintBytes(JSON.stringify(refs.map(ref => {
    const asset = project.assets?.find(item => item.id === ref.assetId);
    return asset ? { id: asset.id, kind: asset.kind, name: asset.name, version: asset.version, refs: asset.refs ?? [] } : { id: ref.assetId, version: ref.version, missing: true };
  })));
}

export function sceneEncoding(fast?: boolean): { crf: number; preset: string } {
  return fast ? { crf: 24, preset: "veryfast" } : { crf: 20, preset: "medium" };
}

export function sceneCacheKey(input: {
  environment: NativeCacheEnvironment;
  scene: Scene;
  media: string | undefined;
  assets: string;
  previousShared: unknown;
  theme: unknown;
  width: number;
  height: number;
  fps: number;
  duration: number;
  plate: boolean;
  encoding: { crf: number; preset: string };
}): string {
  return fingerprintBytes(JSON.stringify({
    environment: input.environment,
    scene: input.scene,
    media: input.media,
    assets: input.assets,
    previous: input.previousShared,
    theme: input.theme,
    width: input.width,
    height: input.height,
    fps: input.fps,
    duration: input.duration,
    plate: input.plate,
    encoding: input.encoding,
  }));
}

export function visualSceneIdentity(scene: Scene, plate: boolean): Scene {
  const copy = structuredClone(scene);
  // Audio paths/notes/quiz do not change pixels. Word timings do when captions are burned in.
  delete copy.narration.audioRef; delete copy.notes; delete copy.quiz;
  if (plate) delete copy.narration.segments;
  return copy;
}

export function cacheArtifactValid(file: string): boolean {
  try {
    const metadata = JSON.parse(fs.readFileSync(`${file}.sha256.json`, "utf8"));
    return fs.statSync(file).size > 32 && metadata.sha256 === fingerprintBytes(fs.readFileSync(file));
  } catch { return false; }
}

export function recordCacheArtifact(file: string) {
  fs.writeFileSync(`${file}.sha256.json`, JSON.stringify({ sha256: fingerprintBytes(fs.readFileSync(file)) }));
}
