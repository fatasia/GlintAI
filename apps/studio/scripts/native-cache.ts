import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Scene, SceneScriptProject } from "@glintai/scenescript";
import { resolveMediaPath } from "./native-process";
import { browserIdentity } from "./direct-browser/host";

export const fingerprintBytes = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Hash file contents, not just names: replacing a reference image must invalidate its scene. */
export function assetFingerprint(projectDir: string): string {
  const root = path.join(projectDir, "assets");
  if (!fs.existsSync(root)) return "no-assets";
  const files: { path: string; sha256: string }[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Asset symlinks are forbidden");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ path: path.relative(root, file).split(path.sep).join("/"), sha256: fingerprintBytes(fs.readFileSync(file)) });
    }
  };
  visit(root);
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
const IMPLEMENTATION_FILES = [
  "native-render.ts",
  "native-stitch.ts",
  "native-cache.ts",
  "native-svg/text.ts",
  "native-svg/charts.ts",
  "native-svg/index.ts",
  "native-svg/outline.ts",
  "direct-browser/host.ts",
  "direct-browser/index.ts",
  "direct-browser/page.ts",
  "../../../packages/scenescript/src/motion.ts",
  "../../../packages/scenescript/src/effects.ts",
  "../../../packages/design-tokens/src/index.ts",
  // The browser runtime renders HTML scenes; editing it changes pixels too.
  "../../../packages/video/src/scenes/html-runtime.ts",
  "../../../packages/video/src/scenes/html-policy.ts",
];

export function renderImplementationFingerprint(scriptDir: string): string {
  const resolved = IMPLEMENTATION_FILES.map(file => [file, path.resolve(scriptDir, file)] as const);
  if (resolved.some(([, file]) => !fs.existsSync(file))) {
    // Packaged builds carry no TypeScript sources; the build id stands in for them.
    return fingerprintBytes(JSON.stringify({ bundled: process.env.GLINT_BUILD_ID ?? "bundled", files: IMPLEMENTATION_FILES.length }));
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
 * Font identity used to invalidate caches.
 * Pinned fonts hash name+size+mtime. System fonts hash a bounded directory scan,
 * so a font change on Linux/macOS no longer reuses a stale glyph cache (it used
 * to be an empty array, which silently matched every machine).
 */
export function fontFingerprint(files: readonly string[], options: { systemFonts: boolean }): unknown {
  if (files.length) return { mode: "pinned", files: files.map(file => ({ name: path.basename(file), size: fs.statSync(file).size, mtime: fs.statSync(file).mtimeMs })) };
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
  sourceFingerprint: string;
  fontIdentity: unknown;
}

/** One immutable description of the host that rendered a frame. */
export function nativeCacheEnvironment(scriptDir: string, options: { browserRequired: boolean; fontFiles: readonly string[] }): NativeCacheEnvironment {
  return {
    renderer: 2,
    platform: process.platform,
    resvg: packageVersion("@resvg/resvg-js") ?? "unknown",
    browser: options.browserRequired ? browserIdentity() ?? "missing" : "none",
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
