import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { diffFingerprints, fingerprintDistance, frameFingerprint, frameTimecode, type FrameDiff } from "@glintai/mediadiff";
import { readArg } from "./glint-runtime";

/** Runs a media tool and returns stdout bytes; stderr is kept only for the error message. */
export function captureProcess(command: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let stderr = "";
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 180_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("Operation cancelled"));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

export interface FrameHashOptions { fps?: number; width?: number; height?: number; signal?: AbortSignal; timeoutMs?: number }

/**
 * Decodes a video into 9×8 grayscale frames at a fixed sampling rate and hashes
 * each one. Sampling is deliberately coarse: the goal is "which time ranges
 * changed", not perceptual quality scoring.
 */
export async function extractFrameHashes(video: string, options: FrameHashOptions = {}): Promise<{ hashes: string[]; fps: number }> {
  const file = path.resolve(video);
  if (!fs.existsSync(file)) throw new Error(`Video not found: ${file}`);
  const fps = options.fps ?? 2, width = options.width ?? 16, height = options.height ?? 16;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 30) throw new Error("fps must be 0..30");
  if (width < 16 || height < 16) throw new Error("Sample size must be at least 16×16");
  const raw = await captureProcess("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${fps},scale=${width}:${height}:flags=area`, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], { signal: options.signal, timeoutMs: options.timeoutMs });
  const frameBytes = width * height;
  const count = Math.floor(raw.length / frameBytes);
  if (count === 0) throw new Error(`No frames decoded from ${file}`);
  const hashes: string[] = [];
  for (let index = 0; index < count; index++) hashes.push(frameFingerprint(new Uint8Array(raw.subarray(index * frameBytes, (index + 1) * frameBytes)), width, height));
  return { hashes, fps };
}

export interface VisualDiffOptions extends FrameHashOptions { cellThreshold?: number; changedCells?: number; maxChangedRatio?: number }

/** Compares rendered pixels of two videos and reports changed time ranges. */
export async function diffVideos(before: string, after: string, options: VisualDiffOptions = {}): Promise<FrameDiff> {
  const [a, b] = await Promise.all([extractFrameHashes(before, options), extractFrameHashes(after, options)]);
  return diffFingerprints(a.hashes, b.hashes, { cellThreshold: options.cellThreshold, changedCells: options.changedCells, maxChangedRatio: options.maxChangedRatio });
}

export function formatDiff(diff: FrameDiff, fps: number): string {
  if (!diff.changed.length) return `no visual change across ${diff.total} sampled frames`;
  const lines = diff.ranges.map(([start, end]) => `  ${frameTimecode(start, fps)} → ${frameTimecode(end + 1, fps)}  ${end - start + 1} frame(s)`);
  return [`${diff.changed.length}/${diff.total} sampled frames changed (${(diff.ratio * 100).toFixed(2)}%), max distance ${diff.maxDistance}`, ...lines].join("\n");
}

/** `glint diff --before=a.mp4 --after=b.mp4 [--fps=2] [--strict] [--out=diff.json]` */
export async function runFrameDiff(args: string[]): Promise<void> {
  const before = readArg(args, "before"), after = readArg(args, "after");
  if (!before || !after) throw new Error("diff requires --before=<video> and --after=<video>");
  const fps = Number(readArg(args, "fps") ?? 2);
  const diff = await diffVideos(before, after, {
    fps,
    cellThreshold: readArg(args, "threshold") !== undefined ? Number(readArg(args, "threshold")) : undefined,
    changedCells: readArg(args, "changed-cells") !== undefined ? Number(readArg(args, "changed-cells")) : undefined,
    maxChangedRatio: readArg(args, "max-ratio") !== undefined ? Number(readArg(args, "max-ratio")) : undefined,
  });
  console.log(`[glint] diff: ${formatDiff(diff, fps)}`);
  const out = readArg(args, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify({ ...diff, fps }, null, 2)); console.log(`[glint] diff → ${path.resolve(out)}`); }
  if (args.includes("--strict") && !diff.pass) process.exitCode = 1;
}

/** Decoded frame count via ffprobe; undefined when ffprobe is unavailable. */
export async function probeFrameCount(video: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const raw = await captureProcess("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=nokey=1:noprint_wrappers=1", video], { signal, timeoutMs: 120_000 });
    const count = Number(raw.toString("utf8").trim().split("\n")[0]);
    return Number.isInteger(count) && count > 0 ? count : undefined;
  } catch { return undefined; }
}