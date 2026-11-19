import fs from "node:fs/promises";
import { createReadStream, existsSync, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { captureProcess } from "./frame-diff";
import { runMediaProcess } from "./native-process";
import { readArg } from "./glint-runtime";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { reviewTemporalFrames } from "./reference-temporal";

const MAX_DURATION_MS = 600_000, MAX_BYTES = 2 * 1024 ** 3, TIMEOUT_MS = 180_000;
const MAX_DIMENSION = 8192, MAX_PIXELS = 33_554_432, MAX_FPS = 120, MAX_STDERR_BYTES = 32 * 1024 ** 2;
const ADAPTIVE_FLOOR = 0.025, MAX_ADAPTIVE_CANDIDATES = 120;
const NEIGHBOR_PERCENTILE = 0.75, WEAK_CANDIDATE_RATIO = 1.6, TEMPORAL_FRAMES_BEFORE = 4, TEMPORAL_FRAMES_AFTER = 5;
// Exclude playlists, concat, image sequences and other indirect/network-bearing demuxers.
const FORMATS = "mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,flv,ogg";
const LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS];
export interface ReferenceOptions { videoPath: string; outDir: string; threshold?: number; minShotMs?: number; maxShots?: number; signal?: AbortSignal }
export interface ReferenceAnalysis {
  format: "glint-reference-analysis"; version: 1;
  source: { name: string; sha256: string; bytes: number; durationMs: number; width: number; height: number; fps: number };
  shots: { id: string; startMs: number; endMs: number; thumbnail: string; /** Mean absolute luma difference of two sampled frames; null when unavailable, not pose or skeleton. */ motion: number | null; /** Boundary-frame luma difference, not a probability of a correct cut. */ boundaryChange?: number | null }[];
  limits: {
    threshold: number; minShotMs: number; maxShots: number; maxShotsAllowed: number;
    maxDurationMs: number; maxBytes: number; maxDimension: number; maxPixels: number; maxFps: number;
    timeoutMs: number; maxStderrBytes: number; detectedCuts: number; mergedCuts: number; omittedCuts: number; shotCapReached: boolean;
    detector?: "adaptive-local-v1" | "adaptive-temporal-v2" | "scene-threshold"; adaptiveCandidatesSkipped?: number;
    /** Review hints, not confirmed cuts or probabilities. */
    uncertainCuts?: { timeMs: number; reason: string }[];
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

type SceneScore = { timeMs: number; score: number };

/** Select at most one early candidate per time bucket first, then evenly fill unused capacity. */
export function selectAdaptiveCandidates(candidates: SceneScore[], durationMs: number): { selected: SceneScore[]; skipped: number } {
  const unique = new Map<number, SceneScore>();
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.timeMs) || candidate.timeMs <= 0 || candidate.timeMs >= durationMs || !Number.isFinite(candidate.score)) continue;
    const previous = unique.get(candidate.timeMs);
    if (!previous || candidate.score > previous.score) unique.set(candidate.timeMs, candidate);
  }
  const ordered = [...unique.values()].sort((a, b) => a.timeMs - b.timeMs);
  if (ordered.length <= MAX_ADAPTIVE_CANDIDATES) return { selected: ordered, skipped: 0 };
  const buckets = new Map<number, SceneScore>();
  for (const candidate of ordered) {
    const bucket = Math.floor(candidate.timeMs * MAX_ADAPTIVE_CANDIDATES / durationMs);
    if (!buckets.has(bucket)) buckets.set(bucket, candidate);
  }
  const chosen = new Set(buckets.values());
  const remaining = ordered.filter(candidate => !chosen.has(candidate));
  const slots = MAX_ADAPTIVE_CANDIDATES - chosen.size;
  for (let i = 0; i < slots; i++) chosen.add(remaining[Math.floor((i + 0.5) * remaining.length / slots)]!);
  return { selected: ordered.filter(candidate => chosen.has(candidate)), skipped: ordered.length - chosen.size };
}

/** The callback reviews a candidate; skipped candidates are never promoted to cuts. */
export async function reviewAdaptiveCandidates(candidates: SceneScore[], durationMs: number, review: (candidate: SceneScore) => Promise<boolean>) {
  const { selected, skipped } = selectAdaptiveCandidates(candidates, durationMs);
  const cuts: number[] = [];
  for (const candidate of selected) if (await review(candidate)) cuts.push(candidate.timeMs);
  return { cuts, skipped };
}
/** Successful metadata is on stderr; existing process helpers intentionally discard it. */
function sceneScores(video: string, threshold: number, adaptive: boolean, signal: AbortSignal): Promise<SceneScore[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const filter = adaptive ? "select=gte(scene\\,0),metadata=print" : `select=gt(scene\\,${threshold}),metadata=print`;
    const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-v", "info", ...LOCAL_INPUT, "-i", video,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-t", "600.001", "-vf", `setpts=PTS-STARTPTS,${filter}`, "-f", "null", "-"], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let pending = "", tail = "", bytes = 0, failure: Error | undefined, timeMs: number | undefined;
    const scores: SceneScore[] = [];
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
        if (!line.includes("Parsed_metadata")) continue;
        const time = /\bpts_time:([\d.e+-]+)/.exec(line);
        if (time) timeMs = Math.round(Number(time[1]) * 1000);
        const score = /lavfi\.scene_score=([\d.e+-]+)/.exec(line);
        if (score && timeMs !== undefined) { scores.push({ timeMs, score: Number(score[1]) }); timeMs = undefined; }
      }
    });
    child.once("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason ?? new Error("Reference analysis cancelled"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Reference scene detection failed (${code}): ${tail}`));
      else resolve(scores);
    });
  });
}

/** Review strong and weak candidate spikes using bounded, timestamp-ordered temporal evidence. */
async function detectCuts(video: string, threshold: number, adaptive: boolean, durationMs: number, signal: AbortSignal) {
  const scores = await sceneScores(video, threshold, adaptive, signal);
  if (!adaptive) return { cuts: scores.map(item => item.timeMs), skipped: 0, uncertain: [] as { timeMs: number; reason: string }[] };
  const baselines = new Map<number, number>();
  const candidates = scores.filter((item, i) => {
    if (i === 0 || item.score < ADAPTIVE_FLOOR) return false;
    const start = Math.max(1, i - 5);
    const neighbors = scores.slice(start, Math.min(scores.length, i + 6))
      .filter((_, j) => start + j !== i).map(entry => entry.score).sort((a, b) => a - b);
    const baseline = neighbors.length ? neighbors[Math.ceil((neighbors.length - 1) * NEIGHBOR_PERCENTILE)]! : 0;
    baselines.set(item.timeMs, baseline);
    return item.score > threshold || item.score >= baseline * WEAK_CANDIDATE_RATIO;
  });
  const scoreIndex = new Map(scores.map((item, index) => [item.timeMs, index]));
  const uncertain: { timeMs: number; reason: string }[] = [];
  const reviewed = await reviewAdaptiveCandidates(candidates, durationMs, async candidate => {
    signal.throwIfAborted();
    const index = scoreIndex.get(candidate.timeMs)!;
    const previous = scores[index - 1], next = scores[index + 1];
    if (!previous || !next || previous.timeMs >= candidate.timeMs || next.timeMs <= candidate.timeMs) {
      uncertain.push({ timeMs: candidate.timeMs, reason: "insufficient-timestamps" });
      return false;
    }
    const start = Math.max(0, index - TEMPORAL_FRAMES_BEFORE), end = Math.min(scores.length, index + TEMPORAL_FRAMES_AFTER);
    const samples = scores.slice(start, end);
    if (samples.some((item, i) => i > 0 && item.timeMs <= samples[i - 1]!.timeMs)) {
      uncertain.push({ timeMs: candidate.timeMs, reason: "insufficient-timestamps" });
      return false;
    }
    // One seek and bounded sequential decode per candidate; no FPS-based timestamp synthesis.
    const seek = start === 0 ? 0 : (scores[start - 1]!.timeMs + samples[0]!.timeMs) / 2;
    const frames = await sampleFrames(video, seek, samples.length, signal);
    const split = index - start;
    const result = reviewTemporalFrames({ before: frames.slice(0, split), after: frames.slice(split) }, candidate.score, baselines.get(candidate.timeMs) ?? 0);
    if (result.decision !== "cut") uncertain.push({ timeMs: candidate.timeMs, reason: result.reason });
    return result.decision === "cut";
  });
  return { ...reviewed, uncertain };
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
    const detection = await detectCuts(video, threshold, options.threshold === undefined, durationMs, signal);
    const cuts = [...new Set(detection.cuts)].filter(n => Number.isFinite(n) && n > 0 && n < durationMs).sort((a, b) => a - b);
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
      const boundaryChange = index === 0 ? null : await frameDifference(video, Math.max(0, startMs - 1000 / fps), startMs, signal);
      shots.push({ id, startMs, endMs, thumbnail, motion: await shotMotion(video, startMs, endMs, signal), boundaryChange });
    }
    const after = await fs.stat(video);
    if (!same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await digest(video, signal) !== sha256)
      throw new Error("Reference source changed during analysis; no report was published");
    const report: ReferenceAnalysis = { format: "glint-reference-analysis", version: 1,
      source: { name: path.basename(input), sha256, bytes: before.size, durationMs, width, height, fps }, shots,
      limits: { threshold, minShotMs, maxShots, maxShotsAllowed: 30, maxDurationMs: MAX_DURATION_MS, maxBytes: MAX_BYTES,
        maxDimension: MAX_DIMENSION, maxPixels: MAX_PIXELS, maxFps: MAX_FPS, timeoutMs: TIMEOUT_MS, maxStderrBytes: MAX_STDERR_BYTES,
        detectedCuts: cuts.length, mergedCuts, omittedCuts, shotCapReached: omittedCuts > 0,
        detector: options.threshold === undefined ? "adaptive-temporal-v2" : "scene-threshold", adaptiveCandidatesSkipped: detection.skipped,
        uncertainCuts: detection.uncertain, scope: "cuts-thumbnails-and-motion",
        recovery: "Heuristic cuts and reference thumbnails only; no original editable layers, identity, rig, or structure are recovered. Undetected weak cuts and unreviewed candidates may exist; uncertain positions require manual review, not calibrated confidence." }, inferred: true };
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

async function sampleFrames(video: string, atMs: number, count: number, signal: AbortSignal): Promise<Buffer[]> {
  const raw = await captureProcess("ffmpeg", ["-nostdin", "-v", "error", ...LOCAL_INPUT, "-ss", String(atMs / 1000), "-i", video,
    "-frames:v", String(count), "-an", "-sn", "-dn", "-vf", "scale=64:36,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { signal, timeoutMs: 30_000 });
  if (raw.length !== count * 64 * 36) return [];
  return Array.from({ length: count }, (_, index) => raw.subarray(index * 64 * 36, (index + 1) * 64 * 36));
}

async function sampleFrame(video: string, atMs: number, signal: AbortSignal): Promise<Buffer> {
  return await captureProcess("ffmpeg", ["-nostdin", "-v", "error", ...LOCAL_INPUT, "-ss", String(atMs / 1000), "-i", video,
    "-frames:v", "1", "-an", "-sn", "-dn", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], { signal, timeoutMs: 30_000 });
}

function lumaDifference(a: Buffer, b: Buffer): number | null {
  if (a.length !== 64 * 36 || b.length !== 64 * 36) return null;
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index]! - b[index]!);
  return Math.round((total / a.length / 255) * 1000) / 1000;
}

/** Mean absolute luma difference between two sampled frames (0..1). Not pose, skeleton or camera tracking. */
async function frameDifference(video: string, firstMs: number, secondMs: number, signal: AbortSignal): Promise<number | null> {
  const [a, b] = await Promise.all([sampleFrame(video, firstMs, signal), sampleFrame(video, secondMs, signal)]);
  return lumaDifference(a, b);
}

async function shotMotion(video: string, startMs: number, endMs: number, signal: AbortSignal): Promise<number | null> {
  const span = endMs - startMs;
  if (span < 300) return null;
  return await frameDifference(video, startMs + span * 0.25, startMs + span * 0.75, signal);
}

export async function runReferenceVideo(args: string[]): Promise<void> {
  const videoPath = readArg(args, "video"), outDir = readArg(args, "out");
  if (!videoPath || !outDir) throw new Error("reference requires --video=<local video> --out=<new directory>");
  const report = await analyzeReference({ videoPath, outDir,
    threshold: readArg(args, "threshold") === undefined ? undefined : Number(readArg(args, "threshold")),
    minShotMs: readArg(args, "min-shot-ms") === undefined ? undefined : Number(readArg(args, "min-shot-ms")),
    maxShots: readArg(args, "max-shots") === undefined ? undefined : Number(readArg(args, "max-shots")) });
  const moving = report.shots.filter(shot => shot.motion !== null && shot.motion >= 0.08).length;
  const unavailable = report.shots.filter(shot => shot.motion === null).length;
  if (report.limits.uncertainCuts?.length) console.log(`[glint] Needs manual review (not confirmed cuts): ${report.limits.uncertainCuts.map(item => `${item.timeMs}ms (${item.reason})`).join(", ")}`);
  console.log(`[glint] reference: ${report.shots.length} inferred shot(s), ${moving} with notable motion, ${unavailable} without a motion measurement; ${report.limits.mergedCuts} close cuts merged, ${report.limits.omittedCuts} cuts omitted by shot cap; ${report.limits.adaptiveCandidatesSkipped ?? 0} adaptive candidates skipped without flash review due to review cap. Cuts are heuristic, not verified accuracy. Motion is frame-difference only: no pose, rig, layers or original project are recovered.`);
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
    const motion = shot.motion;
    const camera = motion !== null && motion >= 0.08 ? { type: "static" as const } : motion !== null && motion > 0 && motion <= 0.02 ? { type: "push" as const, intensity: 0.25 } : undefined;
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
