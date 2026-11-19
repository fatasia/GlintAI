import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runMediaProcess } from "./native-process";
import { captureLook, diagnoseLook, LOOK_LOCAL_INPUT } from "./look-diagnostics";

export interface LookOptions { video: string; out: string; samples?: number; at?: number; start?: number; end?: number; signal?: AbortSignal }
const finite = (n: number) => Number.isFinite(n);
async function hash(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function validate(options: LookOptions) {
  options.signal?.throwIfAborted();
  if (!options.video || !options.out || /^(?:https?|file):/i.test(options.video)) throw new Error("look requires a local --video and new --out directory");
  const file = path.resolve(options.video), out = path.resolve(options.out);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error("look input must be a file no larger than 2 GiB");
  const samples = options.samples ?? 8;
  if (!Number.isInteger(samples) || samples < 1 || samples > 24) throw new Error("samples must be an integer in 1..24");
  const probe = JSON.parse((await captureLook("ffprobe", ["-v", "error", ...LOOK_LOCAL_INPUT, "-show_streams", "-show_format", "-of", "json", file], options.signal)).stdout);
  const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const duration = Number(probe.format?.duration ?? video?.duration);
  if (!video || !finite(duration) || duration <= 0 || duration > 600) throw new Error("look requires a video duration in (0,600] seconds");
  if (!finite(Number(video.width)) || !finite(Number(video.height)) || video.width <= 0 || video.height <= 0 || video.width > 8192 || video.height > 8192 || video.width * video.height > 33_554_432) throw new Error("Video dimensions exceed the inspection limit");
  const [num, den] = String(video.r_frame_rate).split("/").map(Number);
  if (!finite(num! / den!) || num! / den! <= 0 || num! / den! > 120) throw new Error("Video frame rate must be in (0,120]");
  if (options.at !== undefined && (!finite(options.at) || options.at < 0 || options.at >= duration)) throw new Error("at must be inside the video (seconds)");
  if ((options.start === undefined) !== (options.end === undefined)) throw new Error("Provide both start and end (seconds)");
  if (options.start !== undefined && (!finite(options.start) || !finite(options.end!) || options.start < 0 || options.end! > duration || options.end! <= options.start || options.end! - options.start > 30)) throw new Error("Interval must be inside the video and no longer than 30 seconds");
  return { file, out, duration, samples, hasAudio: probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio") };
}

async function extract(file: string, out: string, times: number[], options: LookOptions) {
  const frame = async (time: number, name: string) => {
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", ...LOOK_LOCAL_INPUT, "-i", file, "-ss", String(time), "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2", path.join(out, name)], { signal: options.signal });
    if (!(await fs.stat(path.join(out, name))).size) throw new Error("No frame decoded at requested time");
  };
  for (let index = 0; index < times.length; index++) await frame(times[index]!, `sample-${String(index).padStart(2, "0")}.png`);
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", "-framerate", "1", "-i", path.join(out, "sample-%02d.png"), "-vf", `tile=${Math.min(4, times.length)}x${Math.ceil(times.length / 4)}`, "-frames:v", "1", path.join(out, "contact.png")], { signal: options.signal });
  if (options.at !== undefined) await frame(options.at, "frame.png");
  if (options.start !== undefined) await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", ...LOOK_LOCAL_INPUT, "-i", file, "-ss", String(options.start), "-t", String(options.end! - options.start), "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(out, "interval.mp4")], { signal: options.signal });
}

/** Read-only media inspection. Suspicions are data, not an editorial verdict. */
export async function inspectLook(options: LookOptions) {
  const input = await validate(options);
  const before = await hash(input.file);
  await fs.mkdir(input.out); // exclusive: preserve every pre-existing output directory
  const times = Array.from({ length: input.samples }, (_, i) => input.duration * (i + 0.5) / input.samples);
  await extract(input.file, input.out, times, options);
  const diagnostics = await diagnoseLook(input.file, input.duration, input.hasAudio, options.signal);
  if (before !== await hash(input.file)) throw new Error("Input changed during inspection; rerun with a stable file");
  const files = await fs.readdir(input.out);
  const artifacts = await Promise.all(files.map(async name => ({ path: name, sha256: await hash(path.join(input.out, name)), bytes: (await fs.stat(path.join(input.out, name))).size })));
  const report = { version: 1, sourceSha256: before, duration: input.duration, streamSelection: "first video / first audio", samples: times.map((seconds, index) => ({ seconds, path: `sample-${String(index).padStart(2, "0")}.png` })),
    frame: options.at === undefined ? null : { seconds: options.at, path: "frame.png" }, interval: options.start === undefined ? null : { start: options.start, end: options.end, path: "interval.mp4" }, diagnostics, artifacts,
    limitations: ["Frames are nearest decoded frames at requested timestamps, not exact subframe samples.", "Contact samples do not replace full visual review. Use delivery-check for full decode, loudness and true peak."] };
  await fs.writeFile(path.join(input.out, "look.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}

export async function runLook(args: string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(video|out|samples|at|start|end)=(.+)$/.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error("look accepts --video= --out= [--samples=8 --at=<seconds> --start=<seconds> --end=<seconds>]");
    values.set(match[1]!, match[2]!);
  }
  const number = (key: string) => values.has(key) ? Number(values.get(key)) : undefined;
  const result = await inspectLook({ video: values.get("video") ?? "", out: values.get("out") ?? "", samples: number("samples"), at: number("at"), start: number("start"), end: number("end") });
  console.log(JSON.stringify(result, null, 2)); return result;
}
