import fs from "node:fs/promises";
import { createReadStream, existsSync, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { captureProcess } from "./frame-diff";
import { runMediaProcess } from "./native-process";
import { readArg } from "./glint-runtime";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

const MAX_DURATION_MS = 600_000, MAX_BYTES = 2 * 1024 ** 3, TIMEOUT_MS = 180_000;
const MAX_DIMENSION = 8192, MAX_PIXELS = 33_554_432, MAX_FPS = 120, MAX_STDERR_BYTES = 16 * 1024 ** 2;
// Exclude playlists, concat, image sequences and other indirect/network-bearing demuxers.
const FORMATS = "mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,flv,ogg";
const LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS];
export interface ReferenceOptions { videoPath: string; outDir: string; threshold?: number; minShotMs?: number; maxShots?: number; signal?: AbortSignal }
export interface ReferenceAnalysis {
  format: "glint-reference-analysis"; version: 1;
  source: { name: string; sha256: string; bytes: number; durationMs: number; width: number; height: number; fps: number };
  shots: { id: string; startMs: number; endMs: number; thumbnail: string; /** Mean absolute luma difference of two sampled frames; not pose or skeleton. */ motion: number }[];
  limits: {
    threshold: number; minShotMs: number; maxShots: number; maxShotsAllowed: number;
    maxDurationMs: number; maxBytes: number; maxDimension: number; maxPixels: number; maxFps: number;
    timeoutMs: number; maxStderrBytes: number; detectedCuts: number; mergedCuts: number; omittedCuts: number; shotCapReached: boolean;
    scope: "cuts-thumbnails-and-motion"; recovery: string;
  };
  inferred: true;
}

function localPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value.replace(/^[a-z]:[\\/]/i, "")) || /^[\\/]{2}/.test(value))
    throw new Error("Reference paths must be local filesystem paths, not URLs or network shares");
  return path.resolve(value);
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
async function digest(file: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  return hash.digest("hex");
}

/** Successful showinfo is on stderr; existing process helpers intentionally discard it. */
function sceneCuts(video: string, threshold: number, signal: AbortSignal): Promise<number[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-v", "info", ...LOCAL_INPUT, "-i", video,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-t", "600.001", "-vf", `setpts=PTS-STARTPTS,select=gt(scene\\,${threshold}),showinfo`, "-f", "null", "-"], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let pending = "", tail = "", bytes = 0, failure: Error | undefined;
    const cuts: number[] = [];
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length; tail = (tail + chunk.toString("utf8")).slice(-4000);
      if (bytes > MAX_STDERR_BYTES) { failure = new Error("Scene detection exceeded its bounded stderr budget"); child.kill(); return; }
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
      if (pending.length > 16_384) { failure = new Error("Scene detection emitted an oversized log line"); child.kill(); return; }
      for (const line of lines) {
        const match = /\bpts_time:([\d.e+-]+)/.exec(line);
        if (line.includes("showinfo") && match) cuts.push(Math.round(Number(match[1]) * 1000));
      }
    });
    child.once("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason ?? new Error("Reference analysis cancelled"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Reference scene detection failed (${code}): ${tail}`));
      else resolve(cuts);
    });
  });
}

/** Local, heuristic shot timing only. Never reconstructs editable layers, identity, rigs or structure. */
export async function analyzeReference(options: ReferenceOptions): Promise<ReferenceAnalysis> {
  const threshold = options.threshold ?? 0.3, minShotMs = options.minShotMs ?? 500, maxShots = options.maxShots ?? 12;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("threshold must be between 0 and 1");
  if (!Number.isInteger(minShotMs) || minShotMs < 1 || minShotMs > MAX_DURATION_MS) throw new Error("minShotMs must be an integer from 1 to 600000");
  if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 30) throw new Error("maxShots must be an integer from 1 to 30");
  const input = localPath(options.videoPath), requestedOut = localPath(options.outDir);
  // Resolve the parent once, then use exclusive mkdir: existing files, directories and symlinks all refuse.
  const out = path.join(localPath(await fs.realpath(path.dirname(requestedOut))), path.basename(requestedOut));
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  signal.throwIfAborted();
  await fs.mkdir(out);
  const ownedDirs: { file: string; stat: Stats }[] = [], ownedFiles: { file: string; stat: Stats; dir: string }[] = [];
  let complete = false;
  const ownsDir = async (dir: string) => {
    const owned = ownedDirs.find(entry => entry.file === dir), current = await fs.lstat(dir).catch(() => undefined);
    return !!owned && !!current?.isDirectory() && same(owned.stat, current);
  };
  const cleanup = async (dir: string) => {
    if (!await ownsDir(dir)) return;
    for (const entry of ownedFiles.filter(entry => entry.dir === dir)) {
      const current = await fs.lstat(entry.file).catch(() => undefined);
      if (current?.isFile() && same(entry.stat, current) && await ownsDir(dir)) await fs.unlink(entry.file).catch(() => {});
    }
    // Never recursively delete: unexpected files or replaced directories are left untouched.
    if (await ownsDir(dir)) await fs.rmdir(dir).catch(() => {});
  };
  try {
    ownedDirs.push({ file: out, stat: await fs.lstat(out) });
    const staging = await fs.mkdtemp(path.join(path.dirname(out), ".glint-reference-"));
    ownedDirs.push({ file: staging, stat: await fs.lstat(staging) });
    const video = localPath(await fs.realpath(input)), before = await fs.stat(video);
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) throw new Error("Reference must be a nonempty local video file no larger than 2 GiB");
    const sha256 = await digest(video, signal);
    const raw = await captureProcess("ffprobe", ["-v", "error", ...LOCAL_INPUT, "-select_streams", "v:0", "-show_entries",
      "stream=width,height,avg_frame_rate,duration:format=duration", "-of", "json", video], { signal, timeoutMs: 30_000 });
    const metadata = JSON.parse(raw.toString("utf8")), stream = metadata.streams?.[0];
    const width = Number(stream?.width), height = Number(stream?.height);
    const [numerator, denominator = "1"] = String(stream?.avg_frame_rate).split("/");
    const fps = Number(numerator) / Number(denominator);
    const duration = Number(metadata.format?.duration ?? stream?.duration) * 1000, durationMs = Math.round(duration);
    if (!Number.isFinite(duration) || durationMs < 1 || duration > MAX_DURATION_MS) throw new Error("Reference duration must be positive and at most 10 minutes");
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION) || width * height > MAX_PIXELS || !Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS)
      throw new Error("Reference metadata exceeds supported dimensions, pixel count or frame rate");
    const cuts = [...new Set(await sceneCuts(video, threshold, signal))].filter(n => Number.isFinite(n) && n > 0 && n < durationMs).sort((a, b) => a - b);
    const retained = [0];
    let mergedCuts = 0;
    for (const cut of cuts) {
      if (cut - retained[retained.length - 1]! < minShotMs || durationMs - cut < minShotMs) mergedCuts++;
      else retained.push(cut);
    }
    const omittedCuts = Math.max(0, retained.length - maxShots);
    const boundaries = [...retained.slice(0, maxShots), durationMs];
    const shots: ReferenceAnalysis["shots"] = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      signal.throwIfAborted();
      if (!await ownsDir(out) || !await ownsDir(staging)) throw new Error("Reference output directory changed during analysis");
      const id = `shot-${String(index + 1).padStart(3, "0")}`, thumbnail = `${id}.jpg`, file = path.join(staging, thumbnail);
      const startMs = boundaries[index]!, endMs = boundaries[index + 1]!;
      // Reserve our artifact first: never adopt or clean up a pre-existing file, even on failure.
      const handle = await fs.open(file, "wx"), reserved = await handle.stat();
      ownedFiles.push({ file, stat: reserved, dir: staging }); await handle.close();
      // -y truncates only our reserved staging artifact, never a user-selected output path.
      // Seek at the shot start: even a sub-frame final interval still has a decodable frame.
      await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", ...LOCAL_INPUT, "-i", video, "-ss", String(startMs / 1000),
        "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", "-q:v", "4", "-f", "image2", "-update", "1", file], { signal, timeoutMs: 30_000 });
      const stat = await fs.lstat(file);
      if (!stat.isFile() || !same(reserved, stat) || stat.size < 1) throw new Error("No thumbnail frame decoded or staging artifact changed");
      if (!await ownsDir(out) || !await ownsDir(staging)) throw new Error("Reference output directory changed during analysis");
      const destination = path.join(out, thumbnail);
      await fs.link(file, destination); // Atomic exclusive publication; never overwrite an existing artifact.
      ownedFiles.push({ file: destination, stat, dir: out });
      shots.push({ id, startMs, endMs, thumbnail, motion: await shotMotion(video, startMs, endMs, signal) });
    }
    const after = await fs.stat(video);
    if (!same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await digest(video, signal) !== sha256)
      throw new Error("Reference source changed during analysis; no report was published");
    const report: ReferenceAnalysis = { format: "glint-reference-analysis", version: 1,
      source: { name: path.basename(input), sha256, bytes: before.size, durationMs, width, height, fps }, shots,
      limits: { threshold, minShotMs, maxShots, maxShotsAllowed: 30, maxDurationMs: MAX_DURATION_MS, maxBytes: MAX_BYTES,
        maxDimension: MAX_DIMENSION, maxPixels: MAX_PIXELS, maxFps: MAX_FPS, timeoutMs: TIMEOUT_MS, maxStderrBytes: MAX_STDERR_BYTES,
        detectedCuts: cuts.length, mergedCuts, omittedCuts, shotCapReached: omittedCuts > 0, scope: "cuts-thumbnails-and-motion",
        recovery: "Heuristic cuts and reference thumbnails only; no original editable layers, identity, rig, or structure are recovered." }, inferred: true };
    signal.throwIfAborted();
    if (!await ownsDir(out)) throw new Error("Reference output directory changed during analysis");
    const file = path.join(out, "analysis.json"), handle = await fs.open(file, "wx");
    try { ownedFiles.push({ file, stat: await handle.stat(), dir: out }); await handle.writeFile(JSON.stringify(report, null, 2) + "\n"); }
    finally { await handle.close(); }
    signal.throwIfAborted(); complete = true;
    return report;
  } finally {
    for (const entry of [...ownedDirs].reverse()) if (entry.file !== out || !complete) await cleanup(entry.file);
  }
}

/** Mean absolute luma difference between two sampled frames (0..1). Not pose, skeleton or camera tracking. */
async function shotMotion(video: string, startMs: number, endMs: number, signal: AbortSignal): Promise<number> {
  const span = endMs - startMs;
  if (span < 300) return 0;
  const frame = async (atMs: number) => await captureProcess("ffmpeg", ["-nostdin", "-v", "error", ...LOCAL_INPUT, "-ss", String(atMs / 1000), "-i", video,
    "-frames:v", "1", "-an", "-sn", "-dn", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], { signal, timeoutMs: 30_000 });
  const [a, b] = await Promise.all([frame(startMs + span * 0.25), frame(startMs + span * 0.75)]);
  if (!a.length || a.length !== b.length) return 0;
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index]! - b[index]!);
  return Math.round((total / a.length / 255) * 1000) / 1000;
}

export async function runReferenceVideo(args: string[]): Promise<void> {
  const videoPath = readArg(args, "video"), outDir = readArg(args, "out");
  if (!videoPath || !outDir) throw new Error("reference requires --video=<local video> --out=<new directory>");
  const report = await analyzeReference({ videoPath, outDir,
    threshold: readArg(args, "threshold") === undefined ? undefined : Number(readArg(args, "threshold")),
    minShotMs: readArg(args, "min-shot-ms") === undefined ? undefined : Number(readArg(args, "min-shot-ms")),
    maxShots: readArg(args, "max-shots") === undefined ? undefined : Number(readArg(args, "max-shots")) });
  const moving = report.shots.filter(shot => shot.motion >= 0.08).length;
  console.log(`[glint] reference: ${report.shots.length} inferred shot(s), ${moving} with notable motion; ${report.limits.mergedCuts} close cuts merged, ${report.limits.omittedCuts} cuts omitted by cap. Motion is frame-difference only: no pose, rig, layers or original project are recovered.`);
}

const ASPECT = (width: number, height: number): "16:9" | "9:16" | "1:1" => {
  const ratio = width / height;
  return ratio < 0.8 ? "9:16" : ratio <= 1.2 ? "1:1" : "16:9";
};

/**
 * Turn cuts/thumbnails into a reviewable skeleton. Each shot is an image scene
 * using the extracted reference frame; the user replaces materials and copy.
 * This is NOT recovery of the original project: timing is heuristic and the
 * frames are references, not editable layers.
 */
export function buildReferenceProject(report: ReferenceAnalysis, options: { title?: string } = {}): SceneScriptProject {
  if (report?.format !== "glint-reference-analysis" || report.version !== 1 || !Array.isArray(report.shots) || !report.shots.length || report.shots.length > 30) {
    throw new Error("Reference analysis must be a version-1 report with 1..30 shots");
  }
  const names = new Set<string>();
  const scenes = report.shots.map((shot, index) => {
    if (!shot || !/^shot-\d{3}\.jpg$/.test(shot.thumbnail) || names.has(shot.thumbnail)) throw new Error("Reference thumbnails must be unique shot-NNN.jpg files");
    names.add(shot.thumbnail);
    if (!Number.isInteger(shot.startMs) || !Number.isInteger(shot.endMs) || shot.startMs < 0 || shot.endMs <= shot.startMs) throw new Error("Reference shot ranges must be positive integer milliseconds");
    const durationMs = Math.max(100, shot.endMs - shot.startMs);
    // Motion hint affects the camera only: busy reference → keep still; calm reference → slow push.
    const camera = shot.motion >= 0.08 ? { type: "static" as const } : shot.motion > 0 && shot.motion <= 0.02 ? { type: "push" as const, intensity: 0.25 } : undefined;
    return {
      id: `ref-shot-${String(index + 1).padStart(3, "0")}`,
      kind: "image" as const,
      src: `assets/reference-${shot.thumbnail}`,
      narration: { text: `参考镜头 ${index + 1}：${(shot.startMs / 1000).toFixed(1)}–${(shot.endMs / 1000).toFixed(1)} 秒。请替换为你的素材，并改成你自己的旁白。`, durationMs },
      ...(camera ? { camera } : {}),
    };
  });
  return parseProject({ schemaVersion: 1, id: "reference-rebuild", title: options.title ?? "参考重建（推断）", aspect: ASPECT(report.source.width, report.source.height),
    knowledgeSources: [], scenes });
}

/** Copies reference frames into <analysis>/assets and writes a new project.json (never overwrites). */
export async function runReferenceProject(args: string[]): Promise<void> {
  const analysisPath = readArg(args, "analysis"), output = readArg(args, "out"), title = readArg(args, "title");
  if (!analysisPath || !output) throw new Error("reference-project requires --analysis=<analysis.json> --out=<new project.json>");
  const directory = path.dirname(path.resolve(analysisPath));
  let report: ReferenceAnalysis;
  try { report = JSON.parse(await fs.readFile(path.resolve(analysisPath), "utf8")); }
  catch { throw new Error("Cannot read the reference analysis file"); }
  const project = buildReferenceProject(report, title ? { title } : {});
  const projectPath = path.resolve(output);
  if (existsSync(projectPath)) throw new Error("Output project already exists; choose a new path. Nothing was overwritten.");
  const assets = path.join(directory, "assets");
  await fs.mkdir(assets, { recursive: true });
  for (const shot of report.shots) {
    const source = path.join(directory, shot.thumbnail), destination = path.join(assets, `reference-${shot.thumbnail}`);
    if (existsSync(destination)) throw new Error("Reference frame asset already exists; use a new analysis directory");
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Reference frame is missing or not a regular file: ${shot.thumbnail}`);
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output: projectPath, scenes: project.scenes.length, assets, inferred: true,
    note: "参考帧仅用于本地预览；交付前请替换素材与旁白。切点与时长是启发式推断，不还原原工程。" }, null, 2));
}
