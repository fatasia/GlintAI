// Portions derived from OpenMotion (nexu-io/openmotion) openmotion-recreate skill, Apache-2.0. Modifications: rewritten for Glint CLI and zh-CN.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

const run = promisify(execFile);

/**
 * 参考片复刻工作流（R-10）：数字测量 → Keep/Replace 逐镜表 → SceneScript 骨架 → 评审表。
 * 流程骨架来自 OpenMotion openmotion-recreate skill（读参考 → 数字测量 → Keep/Replace 决策 →
 * 逐镜重建 → 对比评审）；测量全部走本地 ffmpeg，不加任何 LLM 依赖——「内容理解」（Keep/Replace
 * 表怎么填）留给上层 agent 按 skills/glint-video/references/recreate.md 的操作手册自行完成。
 *
 * 与 apps/studio 的分层：web 参考片工作台继续使用 studio 的自适应切镜实现（REF-01/02，含
 * 闪帧评审与缩略图）；本模块是 composer 侧同方法的确定性轻量测量（固定阈值切镜 + 量化主色），
 * 供 `glint analyze-reference` / `glint recreate-plan` 复刻工作流使用。包依赖方向（composer
 * 不能反向依赖 studio app）决定了这里是同技术的独立实现，不是对 studio 代码的复制。
 */

const MAX_DURATION_MS = 600_000, MAX_BYTES = 2 * 1024 ** 3;
const TIMEOUT_MS = 120_000, DETECT_TIMEOUT_MS = 180_000, FRAME_TIMEOUT_MS = 30_000, MAX_STDERR_BYTES = 32 * 1024 ** 2;
// Exclude playlists, concat, image sequences and other indirect/network-bearing demuxers.
const FORMATS = "mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,flv,ogg";
const LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS];

export interface RecreateShot {
  /** 1-based, aligned with measurement.shots order. */
  shot: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Per-shot dominant colors, most frequent first (#rrggbb). */
  palette: string[];
}

export interface CaptionMark {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ReferenceMeasurement {
  format: "glint-reference-measurement";
  version: 1;
  source: { name: string; sha256: string; bytes: number };
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  /** Consecutive shots covering [0, durationMs] with no gaps. */
  shots: RecreateShot[];
  /** Global dominant colors merged over shot midpoints (#rrggbb). */
  palette: string[];
  /**
   * 字幕/口播文本测量位：本模块不产出（OCR/ASR 属独立能力），留空供上层 agent 把
   * `glint reference-ocr` 之类的文本测量结果附进来；结构在此固化，便于 Keep/Replace 表引用。
   */
  captions?: CaptionMark[];
  limits: {
    threshold: number; minShotMs: number; maxShots: number;
    detectedCuts: number; mergedCuts: number; omittedCuts: number;
    scope: "cuts-and-palette";
    recovery: string;
  };
  inferred: true;
}

export interface AnalyzeReferenceOptions {
  threshold?: number;
  minShotMs?: number;
  maxShots?: number;
  signal?: AbortSignal;
}

function localPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value.replace(/^[a-z]:[\\/]/i, "")) || /^[\\/]{2}/.test(value))
    throw new Error("参考片必须是本地文件路径，不能是 URL 或网络共享");
  return path.resolve(value);
}

async function capture(command: string, args: string[], signal?: AbortSignal, timeoutMs = FRAME_TIMEOUT_MS): Promise<{ stdout: Buffer; stderr: string }> {
  const child = run(command, args, { encoding: "buffer", maxBuffer: MAX_STDERR_BYTES, timeout: timeoutMs, killSignal: "SIGKILL", ...(signal ? { signal } : {}) } as never) as Promise<{ stdout: Buffer; stderr: Buffer }>;
  signal?.throwIfAborted();
  const result = await child;
  return { stdout: result.stdout, stderr: result.stderr.toString("utf8") };
}

/** Streamed digest: never loads the whole reference (up to 2 GiB) into memory. */
async function digest(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { ...(signal ? { signal } : {}) })) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest("hex");
}

/** k-means-free palette: bucket a downsampled frame into 4-bit-per-channel bins. */
export function quantizeFramePalette(rgb: Uint8Array, top = 6): { hex: string; share: number }[] {
  const bins = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bin.r += r; bin.g += g; bin.b += b; bin.count++;
    bins.set(key, bin);
  }
  const total = [...bins.values()].reduce((sum, bin) => sum + bin.count, 0) || 1;
  return [...bins.values()]
    .sort((a, b) => b.count - a.count).slice(0, top)
    .map(bin => ({ hex: `#${[bin.r / bin.count, bin.g / bin.count, bin.b / bin.count].map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`, share: bin.count / total }));
}

/** Grab one frame as 160x90 rgb24 pixels; null when the frame cannot be decoded. */
async function grabFrame(video: string, atSec: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const { stdout } = await capture("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(atSec), "-i", video, "-frames:v", "1", "-an", "-sn", "-dn", "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], signal);
    return stdout.length === 160 * 90 * 3 ? new Uint8Array(stdout) : null;
  } catch { return null; }
}

interface SceneScore { timeMs: number; score: number }

/** Fixed-threshold scene scores from ffmpeg's scene detection (metadata on stderr). */
async function sceneScores(video: string, threshold: number, signal?: AbortSignal): Promise<SceneScore[]> {
  const { stderr } = await capture("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-v", "info", ...LOCAL_INPUT, "-i", video,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-t", "600.001", "-vf", `setpts=PTS-STARTPTS,select=gt(scene\\,${threshold}),metadata=print`, "-f", "null", "-"], signal, DETECT_TIMEOUT_MS);
  const scores: SceneScore[] = [];
  let timeMs: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("Parsed_metadata")) continue;
    const time = /\bpts_time:([\d.e+-]+)/.exec(line);
    if (time) timeMs = Math.round(Number(time[1]) * 1000);
    const score = /lavfi\.scene_score=([\d.e+-]+)/.exec(line);
    if (score && timeMs !== undefined) { scores.push({ timeMs, score: Number(score[1]) }); timeMs = undefined; }
  }
  return scores;
}

/** Median shot length in ms; the rhythm anchor the Keep/Replace table should respect. */
export function medianShotMs(measurement: Pick<ReferenceMeasurement, "shots">): number | undefined {
  const durations = measurement.shots.map(shot => shot.durationMs).filter(ms => ms > 0).sort((a, b) => a - b);
  return durations.length ? durations[Math.floor(durations.length / 2)] : undefined;
}

/**
 * 本地数字测量：ffprobe 元数据 + 固定阈值切镜 + 每镜中点主色。纯启发式——切点是亮度
 * 变化推断，不是确认过的真实剪辑；所有结果 `inferred: true`，需人工确认后再重建。
 */
export async function analyzeReference(videoPath: string, options: AnalyzeReferenceOptions = {}): Promise<ReferenceMeasurement> {
  const threshold = options.threshold ?? 0.3, minShotMs = options.minShotMs ?? 500, maxShots = options.maxShots ?? 12;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("threshold 必须在 0 到 1 之间");
  if (!Number.isInteger(minShotMs) || minShotMs < 1 || minShotMs > MAX_DURATION_MS) throw new Error("minShotMs 必须是 1 到 600000 的整数");
  if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 30) throw new Error("maxShots 必须是 1 到 30 的整数");
  const input = localPath(videoPath);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  signal.throwIfAborted();
  const stat = await fs.stat(input);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error("参考片必须是 1 字节到 2 GiB 之间的本地视频文件");
  const sha256 = await digest(input, signal);
  const { stdout } = await capture("ffprobe", ["-v", "error", ...LOCAL_INPUT, "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", input], signal);
  const metadata = JSON.parse(stdout.toString("utf8")), stream = metadata.streams?.[0];
  const width = Number(stream?.width), height = Number(stream?.height);
  const [numerator, denominator = "1"] = String(stream?.avg_frame_rate).split("/");
  const fps = Number(numerator) / Number(denominator);
  const durationMs = Math.round(Number(metadata.format?.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS) throw new Error("参考片时长必须在 1 毫秒到 10 分钟之间");
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) || width * height > 33_554_432 || !Number.isFinite(fps) || fps <= 0 || fps > 120)
    throw new Error("参考片分辨率或帧率超出支持范围");
  const scores = await sceneScores(input, threshold, signal);
  const cuts = [...new Set(scores.map(item => item.timeMs))].filter(n => Number.isFinite(n) && n > 0 && n < durationMs).sort((a, b) => a - b);
  // Merge cuts that would leave a shot shorter than minShotMs (head or tail), then cap the shot count.
  const retained = [0];
  let mergedCuts = 0;
  for (const cut of cuts) {
    if (cut - retained[retained.length - 1]! < minShotMs || durationMs - cut < minShotMs) mergedCuts++;
    else retained.push(cut);
  }
  const omittedCuts = Math.max(0, retained.length - maxShots);
  const boundaries = [...retained.slice(0, maxShots), durationMs];
  const shots: RecreateShot[] = [];
  const mergedBins = new Map<string, { r: number; g: number; b: number; weight: number }>();
  for (let index = 0; index < boundaries.length - 1; index++) {
    signal.throwIfAborted();
    const startMs = boundaries[index]!, endMs = boundaries[index + 1]!;
    const frame = await grabFrame(input, (startMs + endMs) / 2000, signal);
    const entries = frame ? quantizeFramePalette(frame, 8) : [];
    for (const entry of entries.slice(0, 3)) {
      const value = parseInt(entry.hex.slice(1), 16);
      const bin = mergedBins.get(entry.hex) ?? { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, weight: 0 };
      bin.weight += entry.share;
      mergedBins.set(entry.hex, bin);
    }
    const shotPalette = entries.slice(0, 3).map(entry => entry.hex);
    shots.push({ shot: index + 1, startMs, endMs, durationMs: endMs - startMs, palette: shotPalette });
  }
  if (!shots.length) throw new Error("参考片未能切分出任何镜头");
  const palette = [...mergedBins.values()]
    .sort((a, b) => b.weight - a.weight).slice(0, 6)
    .map(bin => `#${[bin.r, bin.g, bin.b].map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`);
  signal.throwIfAborted();
  return {
    format: "glint-reference-measurement", version: 1,
    source: { name: path.basename(input), sha256, bytes: stat.size },
    durationMs, width, height, fps, shots, palette,
    limits: {
      threshold, minShotMs, maxShots, detectedCuts: cuts.length, mergedCuts, omittedCuts,
      scope: "cuts-and-palette",
      recovery: "切点与主色是启发式测量，不还原原工程图层、身份或结构；弱切点可能漏检，短镜头可能被合并。填 Keep/Replace 表前请按证据帧人工核对。",
    },
    inferred: true,
  };
}

/** Keep/Replace 逐镜表的一行：每镜保留什么、替换成什么、证据帧在哪。 */
export interface KeepReplaceRow {
  /** 1-based，必须与测量 shots 一一对应。 */
  shot: number;
  /** 本镜保留的参考片要素（节奏/构图/动效/色彩关系…）。 */
  keep: string;
  /** 本镜替换为用户内容（文案/品牌/素材…）；空串表示原样保留结构仅换内容。 */
  replace: string;
  /** 证据帧时间（毫秒）；缺省用镜头中点。 */
  evidenceMs?: number;
}

export interface RecreatePlan {
  format: "glint-recreate-plan";
  version: 1;
  title: string;
  source: { name: string; sha256: string; durationMs: number };
  /** 中位镜长：逐镜时长对齐与节奏评审的锚点。 */
  medianShotMs: number;
  width: number;
  height: number;
  fps: number;
  shots: RecreateShot[];
  palette: string[];
  table: KeepReplaceRow[];
  /** SceneScript 骨架工程：镜头数与时长对齐测量值，内容是 Keep/Replace 占位。 */
  project: SceneScriptProject;
  inferred: true;
}

const ASPECT = (width: number, height: number): "16:9" | "9:16" | "1:1" => {
  const ratio = width / height;
  return ratio < 0.8 ? "9:16" : ratio <= 1.2 ? "1:1" : "16:9";
};

function isMeasurement(value: unknown): value is ReferenceMeasurement {
  const measurement = value as ReferenceMeasurement;
  return !!measurement && measurement.format === "glint-reference-measurement" && measurement.version === 1
    && Array.isArray(measurement.shots) && measurement.shots.length >= 1 && measurement.shots.length <= 30
    && Number.isFinite(measurement.durationMs) && measurement.durationMs > 0;
}

/** 把 Keep/Replace 逐镜表变成 SceneScript 骨架：镜头数、时长严格对齐测量值，内容是占位说明。 */
export function buildRecreatePlan(measurement: ReferenceMeasurement, keepReplace: KeepReplaceRow[], options: { title?: string } = {}): RecreatePlan {
  if (!isMeasurement(measurement)) throw new Error("测量必须是 version-1 的 glint-reference-measurement 报告（含 1..30 个镜头）");
  if (!Array.isArray(keepReplace) || keepReplace.length < 1)
    throw new Error(`Keep/Replace 表需要恰好覆盖 ${measurement.shots.length} 个镜头`);
  const seen = new Set<number>();
  for (const row of keepReplace) {
    if (!row || !Number.isInteger(row.shot) || row.shot < 1 || row.shot > measurement.shots.length)
      throw new Error(`Keep/Replace 表的镜头号越界：${row?.shot}（合法范围 1..${measurement.shots.length}）`);
    if (seen.has(row.shot)) throw new Error(`Keep/Replace 表重复镜头 ${row.shot}`);
    if (typeof row.keep !== "string" || !row.keep.trim() || typeof row.replace !== "string")
      throw new Error(`Keep/Replace 表镜头 ${row.shot} 的 keep/replace 字段不合法：keep 必填，replace 可为空串`);
    seen.add(row.shot);
  }
  const missing = measurement.shots.map(shot => shot.shot).filter(shot => !seen.has(shot));
  if (missing.length) throw new Error(`Keep/Replace 表缺少镜头：${missing.join("、")}`);
  const rowsByShot = new Map(keepReplace.map(row => [row.shot, row]));
  const scenes = measurement.shots.map(shot => {
    const row = rowsByShot.get(shot.shot)!;
    const replaced = row.replace.trim();
    return {
      id: `recreate-shot-${String(shot.shot).padStart(3, "0")}`,
      kind: "title" as const,
      title: `镜头 ${shot.shot}（待重建）`,
      subtitle: replaced ? `替换：${replaced.slice(0, 60)}` : "原样保留结构，仅换内容",
      narration: {
        text: `参考片镜头 ${shot.shot}（${(shot.startMs / 1000).toFixed(1)}–${(shot.endMs / 1000).toFixed(1)} 秒）。保留：${row.keep.trim()}。替换：${replaced || "无——结构与内容都保留，只按你的品牌微调"}。请把本镜重建为你自己的画面与文案；时长 ${shot.durationMs} ms 不得改动。`,
        durationMs: shot.durationMs,
      },
    };
  });
  const background = measurement.palette[0], accent = measurement.palette[1] ?? measurement.palette[0];
  const project = parseProject({
    schemaVersion: 1,
    id: "reference-recreate",
    title: options.title ?? "参考片复刻（骨架）",
    aspect: ASPECT(measurement.width, measurement.height),
    knowledgeSources: [],
    ...(background ? { theme: { colors: { bg: background, ...(accent ? { accent } : {}) } } } : {}),
    scenes,
  });
  const median = medianShotMs(measurement)!;
  return {
    format: "glint-recreate-plan", version: 1,
    title: options.title ?? "参考片复刻（骨架）",
    source: { name: measurement.source.name, sha256: measurement.source.sha256, durationMs: measurement.durationMs },
    medianShotMs: median, width: measurement.width, height: measurement.height, fps: measurement.fps,
    shots: measurement.shots, palette: measurement.palette, table: keepReplace, project, inferred: true,
  };
}

export interface ReviewRow {
  shot: number;
  startMs: number;
  endMs: number;
  /** 证据帧号（从 0 计，按测量 fps 换算）。 */
  evidenceFrame: number;
  keep: string;
  replace: string;
}

/** 评审表：每镜 Keep 什么 / Replace 什么 / 证据帧号，供对照参考片逐镜核验。 */
export function recreateReviewTable(plan: RecreatePlan): ReviewRow[] {
  if (plan?.format !== "glint-recreate-plan" || plan.version !== 1) throw new Error("复刻计划必须是 version-1 的 glint-recreate-plan");
  const rowsByShot = new Map(plan.table.map(row => [row.shot, row]));
  return plan.shots.map(shot => {
    const row = rowsByShot.get(shot.shot);
    if (!row) throw new Error(`复刻计划缺少镜头 ${shot.shot} 的 Keep/Replace 行`);
    const evidenceMs = Number.isFinite(row.evidenceMs) && row.evidenceMs! >= 0 && row.evidenceMs! <= shot.endMs ? row.evidenceMs! : Math.round((shot.startMs + shot.endMs) / 2);
    return { shot: shot.shot, startMs: shot.startMs, endMs: shot.endMs, evidenceFrame: Math.round(evidenceMs / 1000 * plan.fps), keep: row.keep, replace: row.replace };
  });
}

/** 评审表的 Markdown 渲染（CLI 与 agent 都直接可读）。 */
export function formatReviewTable(rows: ReviewRow[]): string {
  const header = "| 镜 | 时间 | 证据帧 | 保留 | 替换 |", divider = "|---|---|---|---|---|";
  const body = rows.map(row => `| ${row.shot} | ${(row.startMs / 1000).toFixed(1)}–${(row.endMs / 1000).toFixed(1)}s | #${row.evidenceFrame} | ${row.keep.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} | ${row.replace.replace(/\|/g, "\\|").replace(/\r?\n/g, " ") || "（无）"} |`);
  return [header, divider, ...body].join("\n");
}

/**
 * 解析 Keep/Replace 表：JSON 数组，或 agent 手写/LLM 生成的 Markdown 表
 * （表头须含「镜头」「保留」「替换」，可含「证据帧」列——帧号按 fps 换算成毫秒）。
 */
export function parseKeepReplaceTable(text: string, fps?: number): KeepReplaceRow[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const rows = JSON.parse(trimmed) as KeepReplaceRow[];
    if (!Array.isArray(rows) || !rows.length) throw new Error("Keep/Replace JSON 表不能为空");
    return rows;
  }
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("|"));
  if (lines.length < 2) throw new Error("Keep/Replace Markdown 表至少需要表头和一行数据");
  const cells = lines.map(line => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()));
  const header = cells[0]!.map(cell => cell.replace(/\s/g, ""));
  const shotColumn = header.findIndex(cell => cell === "镜头" || cell === "镜");
  const keepColumn = header.indexOf("保留");
  const replaceColumn = header.indexOf("替换");
  const evidenceColumn = header.indexOf("证据帧");
  if (shotColumn < 0 || keepColumn < 0 || replaceColumn < 0)
    throw new Error("Keep/Replace Markdown 表头必须包含「镜头」「保留」「替换」列（证据帧列可选）");
  const width = header.length;
  return cells.slice(1).filter(row => row.length === width && !row.every(cell => /^:?-+:?$/.test(cell))).map(row => {
    const shot = Number(row[shotColumn]);
    const keep = row[keepColumn] ?? "", replace = row[replaceColumn] ?? "";
    const evidence = evidenceColumn >= 0 ? Number(row[evidenceColumn]) : NaN;
    return {
      shot, keep, replace,
      ...(Number.isFinite(evidence) && Number.isInteger(evidence) && evidence >= 0 && typeof fps === "number" && Number.isFinite(fps) ? { evidenceMs: Math.round(evidence / fps * 1000) } : {}),
    };
  }).filter(row => Number.isInteger(row.shot));
}

function readArg(args: string[], name: string): string | undefined {
  return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readNumberArg(args: string[], name: string): number | undefined {
  const value = readArg(args, name);
  return value === undefined ? undefined : Number(value);
}

/** glint analyze-reference：数字测量，输出测量 JSON 与逐镜摘要。 */
export async function runAnalyzeReference(args: string[]): Promise<void> {
  const videoPath = readArg(args, "video"), out = readArg(args, "out");
  if (!videoPath) throw new Error("analyze-reference requires --video=<local video> [--out=<measurement.json>] [--threshold=0.3] [--min-shot-ms=500] [--max-shots=12]");
  const measurement = await analyzeReference(videoPath, {
    threshold: readNumberArg(args, "threshold"),
    minShotMs: readNumberArg(args, "min-shot-ms") === undefined ? undefined : Math.round(readNumberArg(args, "min-shot-ms")!),
    maxShots: readNumberArg(args, "max-shots") === undefined ? undefined : Math.round(readNumberArg(args, "max-shots")!),
  });
  const json = JSON.stringify(measurement, null, 2);
  if (out) {
    const target = path.resolve(out);
    if (await fs.lstat(target).catch(() => undefined)) throw new Error(`输出文件已存在，请换新路径：${out}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, json + "\n", { flag: "wx" });
  }
  console.log(out ? json : `[glint] ${json}`);
  console.log(`[glint] 测量完成：${measurement.shots.length} 镜 / 总时长 ${(measurement.durationMs / 1000).toFixed(2)}s / 中位镜长 ${(medianShotMs(measurement)! / 1000).toFixed(2)}s；主色 ${measurement.palette.slice(0, 3).join(" ")}`);
  console.log(`[glint] ${measurement.limits.recovery}`);
}

/** glint recreate-plan：测量 + Keep/Replace 表 → SceneScript 骨架与评审表。 */
export async function runRecreatePlan(args: string[]): Promise<void> {
  const measurementPath = readArg(args, "measurement"), tablePath = readArg(args, "table"), out = readArg(args, "out"), title = readArg(args, "title");
  if (!measurementPath || !tablePath || !out)
    throw new Error("recreate-plan requires --measurement=<measurement.json> --table=<keep-replace.json|md> --out=<new plan.json> [--title=片名]");
  let measurement: ReferenceMeasurement;
  try { measurement = JSON.parse(await fs.readFile(path.resolve(measurementPath), "utf8")); }
  catch { throw new Error("无法读取测量文件；请先运行 glint analyze-reference"); }
  const table = parseKeepReplaceTable(await fs.readFile(path.resolve(tablePath), "utf8"), measurement.fps);
  const plan = buildRecreatePlan(measurement, table, title ? { title } : {});
  const target = path.resolve(out);
  if (await fs.lstat(target).catch(() => undefined)) throw new Error(`输出文件已存在，请换新路径：${out}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  console.log(`[glint] 复刻骨架已写入 ${out}：${plan.project.scenes.length} 镜 / 中位镜长 ${(plan.medianShotMs / 1000).toFixed(2)}s / 主色 ${plan.palette.slice(0, 3).join(" ")}`);
  console.log("[glint] 逐镜评审表：");
  console.log(formatReviewTable(recreateReviewTable(plan)));
  console.log("[glint] 下一步：按评审表逐镜重建 SceneScript（参考帧见证据帧号），再走 glint render 与 glint verify-export 对照。");
}
