import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { captureProcess } from "./frame-diff";
import { runMediaProcess } from "./native-process";

export interface DeliveryCheckInput {
  videoPath: string;
  audio?: "required" | "optional" | "forbidden";
  targetLufs?: number;
  toleranceLu?: number;
  maxTruePeakDbtp?: number;
  signal?: AbortSignal;
}
export interface DeliveryLoudness {
  streamIndex: number;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  silent: boolean;
}
export interface DeliveryStream {
  index: number;
  type: string;
  codec?: string;
  width?: number;
  height?: number;
  duration?: number;
  channels?: number;
  sampleRate?: number;
  loudness?: DeliveryLoudness;
}
export interface DeliveryCheckReport {
  pass: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  sha256: string | null;
  bytes: number;
  duration?: number;
  streams: DeliveryStream[];
  audioLoudness?: DeliveryLoudness[];
}

const TIMEOUT_MS = 180_000;
const EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".ogv"]);
const LOCAL_INPUT = ["-protocol_whitelist", "file,pipe"];
const emptyReport = (): DeliveryCheckReport => ({ pass: false, checks: [], sha256: null, bytes: 0, streams: [] });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const finite = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string" || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};
function range(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a finite number in ${min}..${max}`);
}

/** Unlike the shared stdout helper, loudnorm needs its bounded stderr tail. */
function captureLoudness(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    const abort = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(abort, TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`Audio measurement failed (${code}): ${stderr}`));
      else resolve(stderr);
    });
  });
}

interface ProbeStream {
  index: number; codec_type: string; codec_name?: string; width?: number; height?: number;
  duration?: string; channels?: number; sample_rate?: string;
}

/** Technical delivery checks only: decoding says nothing about visual or editorial quality. */
export async function checkDelivery(input: DeliveryCheckInput): Promise<DeliveryCheckReport> {
  const report = emptyReport();
  const check = (name: string, pass: boolean, detail: string) => { report.checks.push({ name, pass, detail }); };
  const finish = () => { report.pass = report.checks.length > 0 && report.checks.every(item => item.pass); return report; };
  let stage = "input", timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Delivery check cancelled"));
  try {
    if (!input || typeof input.videoPath !== "string" || !input.videoPath.trim() || input.videoPath.includes("\0")) throw new Error("videoPath must be a nonempty local video path");
    const audio = input.audio ?? "optional";
    if (!["required", "optional", "forbidden"].includes(audio)) throw new Error("audio must be optional, required, or forbidden");
    const target = input.targetLufs ?? -16, tolerance = input.toleranceLu ?? 1, peak = input.maxTruePeakDbtp ?? -1;
    range("targetLufs", target, -70, -5);
    range("toleranceLu", tolerance, 0, 10);
    range("maxTruePeakDbtp", peak, -9, 0);
    const file = path.resolve(input.videoPath);
    if (!EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error("Unsupported video extension");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    timer = setTimeout(() => controller.abort(new Error(`Delivery check timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(file); }
    catch { throw new Error(`Video not found or unreadable: ${file}`); }
    if (!stat.isFile() || stat.size === 0) throw new Error("Video must be a nonempty regular file");
    report.bytes = stat.size;
    check("input", true, `Local video, ${stat.size} bytes`);
    stage = "sha256";
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file, { signal: controller.signal })) hash.update(chunk);
    report.sha256 = hash.digest("hex");
    stage = "probe";
    const raw = await captureProcess("ffprobe", ["-v", "error", ...LOCAL_INPUT, "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration,channels,sample_rate", "-of", "json", file], { signal: controller.signal, timeoutMs: TIMEOUT_MS });
    const probe = JSON.parse(raw.toString("utf8")) as { streams?: ProbeStream[]; format?: { duration?: string } };
    if (!Array.isArray(probe.streams)) throw new Error("ffprobe returned no stream metadata");
    const formatDuration = finite(probe.format?.duration);
    report.streams = probe.streams.map(stream => ({
      index: stream.index, type: stream.codec_type, codec: stream.codec_name,
      width: stream.width, height: stream.height, duration: finite(stream.duration) ?? formatDuration,
      channels: stream.channels, sampleRate: finite(stream.sample_rate),
    }));
    check("probe", true, `${report.streams.length} actual stream(s) found`);
    const video = report.streams.find(stream => stream.type === "video");
    report.duration = video?.duration ?? formatDuration;
    check("video", !!video && (video.width ?? 0) > 0 && (video.height ?? 0) > 0, video ? `${video.width}×${video.height} ${video.codec}` : "No video stream found");
    check("duration", (report.duration ?? 0) > 0, `Duration: ${report.duration ?? "unknown"} seconds`);
    const audioStreams = report.streams.filter(stream => stream.type === "audio");
    const audioPass = audio === "required" ? audioStreams.length > 0 : audio !== "forbidden" || audioStreams.length === 0;
    check("audio-policy", audioPass, `${audioStreams.length} audio stream(s); policy=${audio}`);
    if (!video) return finish();
    stage = "decode";
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-abort_on", "empty_output_stream", ...LOCAL_INPUT, "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { signal: controller.signal, timeoutMs: TIMEOUT_MS });
    check("decode", true, "First video and all audio streams fully decoded; visual quality not assessed");
    if (audioStreams.length) report.audioLoudness = [];
    for (const [ordinal, stream] of audioStreams.entries()) {
      stage = `audio-measurement:${stream.index}`;
      const stderr = await captureLoudness(["-nostdin", "-v", "info", "-xerror", ...LOCAL_INPUT, "-i", file, "-map", `0:a:${ordinal}`, "-vn", "-sn", "-dn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], controller.signal);
      const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
      if (!json) throw new Error("FFmpeg returned no loudnorm input measurements");
      const measured = JSON.parse(json) as { input_i?: string; input_tp?: string };
      const integratedLufs = finite(measured.input_i) ?? null, truePeakDbtp = finite(measured.input_tp) ?? null;
      const silent = measured.input_i?.toLowerCase() === "-inf";
      const loudness = { streamIndex: stream.index, integratedLufs, truePeakDbtp, silent };
      stream.loudness = loudness;
      report.audioLoudness!.push(loudness);
      check(`loudness:${stream.index}`, integratedLufs !== null && Math.abs(integratedLufs - target) <= tolerance, silent ? "Silent audio (-inf LUFS) is not deliverable" : `Input ${integratedLufs ?? "unmeasurable"} LUFS; required ${target} ± ${tolerance} LU`);
      check(`true-peak:${stream.index}`, truePeakDbtp !== null && truePeakDbtp <= peak, `Input true peak ${truePeakDbtp ?? "unmeasurable"} dBTP; maximum ${peak} dBTP`);
    }
    stage = "file-unchanged";
    const after = await fs.promises.stat(file);
    check(stage, stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs, "File size and modification metadata compared before/after analysis");
    controller.signal.throwIfAborted();
  } catch (error) {
    check(controller.signal.aborted ? (input.signal?.aborted ? "cancelled" : "timeout") : stage, false, controller.signal.aborted ? message(controller.signal.reason) : message(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input?.signal?.removeEventListener("abort", abort);
  }
  return finish();
}

/** Prints one JSON report, including invalid arguments; never writes an output file. */
export async function runDeliveryCheck(args: string[]): Promise<DeliveryCheckReport> {
  let report: DeliveryCheckReport;
  try {
    const values = new Map<string, string>();
    const allowed = ["video", "audio-policy", "audio", "target-lufs", "tolerance-lu", "max-true-peak-dbtp"];
    for (const arg of args) {
      const match = /^--([^=]+)=(.*)$/s.exec(arg);
      if (!match || !allowed.includes(match[1]!) || values.has(match[1]!) || !match[2]?.trim()) throw new Error(`Invalid or duplicate delivery-check argument: ${arg}`);
      values.set(match[1]!, match[2]!);
    }
    if (values.has("audio-policy") && values.has("audio")) throw new Error("Provide only --audio-policy or --audio, not both");
    const number = (key: string) => values.has(key) ? Number(values.get(key)) : undefined;
    report = await checkDelivery({ videoPath: values.get("video") ?? "", audio: (values.get("audio-policy") ?? values.get("audio")) as DeliveryCheckInput["audio"], targetLufs: number("target-lufs"), toleranceLu: number("tolerance-lu"), maxTruePeakDbtp: number("max-true-peak-dbtp") });
  } catch (error) {
    report = emptyReport();
    report.checks.push({ name: "arguments", pass: false, detail: message(error) });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
  return report;
}
