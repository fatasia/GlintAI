import fs from "node:fs";
import path from "node:path";
import { nleSourceTimeMs, type NleClip } from "@glintai/scenescript";
import { runMediaProcess } from "./native-process";

export interface NleAudioPart {
  input: string;
  sourceInMs: number;
  startMs: number;
  durationMs: number;
  speed: number;
  volume: number;
  curve?: NleClip["speedCurve"];
  ramp?: NleClip["speedRamp"];
}

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 4;
const BLOCK_FRAMES = 4096;

function atempoChain(speed: number): string {
  const stages: string[] = [];
  let remaining = speed;
  while (remaining > 2) { stages.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { stages.push("atempo=0.5"); remaining *= 2; }
  stages.push(`atempo=${remaining.toFixed(9)}`);
  return stages.join(",");
}

/** Curves use continuous varispeed (pitch follows speed), matching preservesPitch=false in preview. */
function remapPcm(part: NleAudioPart, source: string, output: string, signal?: AbortSignal): void {
  const input = fs.openSync(source, "r");
  const target = fs.openSync(output, "w");
  const sourceFrames = Math.floor(fs.fstatSync(input).size / FRAME_BYTES);
  const cache = new Map<number, Buffer>();
  const sample = (frame: number, channel: number): number => {
    if (frame < 0 || frame >= sourceFrames) return 0;
    const block = Math.floor(frame / BLOCK_FRAMES);
    let bytes = cache.get(block);
    if (!bytes) {
      bytes = Buffer.alloc(BLOCK_FRAMES * FRAME_BYTES);
      fs.readSync(input, bytes, 0, bytes.length, block * bytes.length);
      cache.set(block, bytes);
      if (cache.size > 3) cache.delete(cache.keys().next().value!);
    }
    return bytes.readFloatLE((frame % BLOCK_FRAMES) * FRAME_BYTES + channel * 4);
  };
  const clock = { durationMs: part.durationMs, speed: part.speed, speedCurve: part.curve, speedRamp: part.ramp };
  const totalFrames = Math.round(part.durationMs / 1000 * SAMPLE_RATE);
  try {
    for (let first = 0; first < totalFrames; first += BLOCK_FRAMES) {
      signal?.throwIfAborted();
      const count = Math.min(BLOCK_FRAMES, totalFrames - first);
      const bytes = Buffer.alloc(count * FRAME_BYTES);
      for (let index = 0; index < count; index++) {
        const sourceFrame = nleSourceTimeMs(clock, (first + index) / SAMPLE_RATE * 1000) / 1000 * SAMPLE_RATE;
        const low = Math.floor(sourceFrame), fraction = sourceFrame - low;
        for (let channel = 0; channel < CHANNELS; channel++) {
          const value = sample(low, channel) * (1 - fraction) + sample(low + 1, channel) * fraction;
          bytes.writeFloatLE(value, index * FRAME_BYTES + channel * 4);
        }
      }
      fs.writeSync(target, bytes);
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(target);
  }
}

export async function renderNleAudioPart(part: NleAudioPart, outPath: string, totalMs: number, signal?: AbortSignal): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(path.dirname(outPath), "nle-audio-"));
  const curved = Boolean(part.curve && part.curve !== "linear");
  const placement = `volume=${part.volume},atrim=duration=${part.durationMs / 1000},asetpts=PTS-STARTPTS,adelay=${part.startMs}:all=1,apad=whole_dur=${totalMs / 1000}`;
  const encode = ["-c:a", "pcm_s16le", "-t", String(totalMs / 1000), outPath];
  try {
    if (!curved) {
      await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-ss", String(part.sourceInMs / 1000), "-t", String(part.durationMs * part.speed / 1000), "-i", part.input,
        "-af", `${atempoChain(part.speed)},${placement}`, "-ac", "2", "-ar", String(SAMPLE_RATE), ...encode], { signal, timeoutMs: 300_000 });
      return;
    }
    const decoded = path.join(temporary, "source.pcm"), mapped = path.join(temporary, "mapped.pcm");
    const sourceMs = nleSourceTimeMs({ durationMs: part.durationMs, speed: part.speed, speedCurve: part.curve, speedRamp: part.ramp }, part.durationMs);
    await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-ss", String(part.sourceInMs / 1000), "-t", String(sourceMs / 1000 + 2 / SAMPLE_RATE), "-i", part.input,
      "-map", "0:a:0", "-ac", "2", "-ar", String(SAMPLE_RATE), "-f", "f32le", decoded], { signal, timeoutMs: 300_000 });
    remapPcm(part, decoded, mapped, signal);
    await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", String(SAMPLE_RATE), "-i", mapped,
      "-af", placement, ...encode], { signal, timeoutMs: 300_000 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
