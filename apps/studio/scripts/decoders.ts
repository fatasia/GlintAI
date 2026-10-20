import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Runtime decoder assets that sandboxed scene iframes load from the public
 * root. The html scene's GSAP runtime (packages/video/src/scenes/
 * html-runtime.ts) serves `<script src="gsap.min.js">` next to the rendered
 * bundle, so the render entry must copy it out of node_modules before
 * bundling. Call copyRuntimeDecoders(publicDir) once before bundle()/render.
 */

export const RUNTIME_DECODERS = [
  {
    /** Name in the public root; the html runtime references this exact src. */
    file: "gsap.min.js",
    /** Subpath inside the gsap package, resolved via @glintai/video. */
    packageSubpath: "gsap/dist/gsap.min.js",
  },
  { file: "lottie_light.min.js", packageSubpath: "lottie-web/build/player/lottie_light_canvas.min.js" },
] as const;

export interface CopiedDecoder {
  /** Path of the copied file relative to the public root. */
  file: string;
  bytes: number;
}

/**
 * Resolves a runtime file through @glintai/video's dependency graph, so
 * pnpm's isolated node_modules (gsap lives next to its consumer, not the
 * studio root) is respected.
 */
export function resolveRuntimeDecoder(subpath: string): string {
  const videoEntry = createRequire(import.meta.url).resolve("@glintai/video");
  const requireFromVideo = createRequire(videoEntry);
  try {
    return requireFromVideo.resolve(subpath);
  } catch {
    throw new Error(
      `Runtime decoder "${subpath}" is not installed. It ships as a dependency of @glintai/video — run pnpm install.`,
    );
  }
}

/**
 * Copies every runtime decoder into the public root (overwrite-safe:
 * the sources are immutable per installed version). Returns what was copied.
 */
export async function copyRuntimeDecoders(
  publicDir: string,
): Promise<CopiedDecoder[]> {
  await fs.mkdir(publicDir, { recursive: true });
  const copied: CopiedDecoder[] = [];
  for (const decoder of RUNTIME_DECODERS) {
    const source = resolveRuntimeDecoder(decoder.packageSubpath);
    const target = path.join(publicDir, decoder.file);
    const bytes = (await fs.stat(source)).size;
    await fs.copyFile(source, target);
    copied.push({ file: decoder.file, bytes });
  }
  const three = resolveRuntimeDecoder("three");
  const compiled = await build({stdin:{contents:`import * as THREE from ${JSON.stringify(three)}; window.THREE=THREE;`,resolveDir:path.dirname(three)},bundle:true,format:"iife",platform:"browser",minify:true,write:false,legalComments:"inline"});
  const runtime=compiled.outputFiles[0]!.contents;
  await fs.writeFile(path.join(publicDir,"three.runtime.js"),runtime);
  copied.push({file:"three.runtime.js",bytes:runtime.length});
  return copied;
}

/**
 * glTF decoder assets served under decoders/ for DRACO mesh decoding and
 * KTX2 texture transcoding: packages/video/src/scenes/gltf.ts points
 * DRACOLoader at decoders/draco/ and KTX2Loader at decoders/basis/. The
 * gltf/ draco variants are the GLTFLoader-tuned decoder pair three's own
 * compressed-model example uses; only the WASM pair ships because every
 * Remotion render/preview target is WASM-capable.
 */
export const GLTF_DECODER_FILES = [
  { from: "three/examples/jsm/libs/draco/gltf/draco_decoder.wasm", to: "decoders/draco/draco_decoder.wasm" },
  { from: "three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js", to: "decoders/draco/draco_wasm_wrapper.js" },
  { from: "three/examples/jsm/libs/basis/basis_transcoder.js", to: "decoders/basis/basis_transcoder.js" },
  { from: "three/examples/jsm/libs/basis/basis_transcoder.wasm", to: "decoders/basis/basis_transcoder.wasm" },
] as const;

export interface DecoderCopyResult {
  /** Path of the copied file relative to the public root. */
  file: string;
  bytes: number;
  action: "copied" | "kept" | "replaced";
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/**
 * Ensures every glTF decoder file exists under publicDir, byte-identical to
 * the three package copy (so a three version bump self-heals). Idempotent:
 * unchanged files are reported "kept" and left untouched. Sources resolve
 * through @glintai/video's dependency graph via resolveRuntimeDecoder.
 */
export async function ensureDecoders(publicDir: string): Promise<DecoderCopyResult[]> {
  const results: DecoderCopyResult[] = [];
  for (const { from, to } of GLTF_DECODER_FILES) {
    const source = resolveRuntimeDecoder(from);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) {
      throw new Error(`glTF decoder source is missing: ${source}. Reinstall dependencies ("pnpm install").`);
    }
    const dest = path.join(publicDir, ...to.split("/"));
    const exists = await fs.stat(dest).then(() => true, () => false);
    if (exists && (await sha256(dest)) === (await sha256(source))) {
      results.push({ file: to, bytes: stat.size, action: "kept" });
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    results.push({ file: to, bytes: stat.size, action: exists ? "replaced" : "copied" });
  }
  return results;
}

/** CLI: `pnpm --filter glint-studio decoders [--public=<dir>]` — stages every decoder asset before bundling. */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void (async () => {
    const publicArg = process.argv.slice(2).find((arg) => arg.startsWith("--public="));
    if (process.argv.slice(2).some((arg) => !arg.startsWith("--public="))) {
      throw new Error("Unknown decoders option; only --public=<dir> is supported");
    }
    const publicDir = publicArg ? path.resolve(publicArg.slice("--public=".length)) : path.resolve("public");
    for (const copied of await copyRuntimeDecoders(publicDir)) {
      console.log(`[glint] decoders: copied ${copied.file} (${copied.bytes} bytes)`);
    }
    for (const result of await ensureDecoders(publicDir)) {
      console.log(`[glint] decoders: ${result.action} ${result.file} (${result.bytes} bytes)`);
    }
    console.log(`[glint] decoders ready under ${publicDir}`);
  })().catch((error: unknown) => {
    console.error(`[glint] decoders failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
