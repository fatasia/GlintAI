import { spawn } from "node:child_process";
export { generateMiniMaxMusic, type MiniMaxMusicConfig } from "./minimax";
export { generateGatewayMusic } from "./gateway";

export class MusicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicError";
  }
}

export type Mood = "calm" | "warm";

/** Slow sustained chord pads, tuned per mood. Frequencies in Hz. */
const CHORDS: Record<Mood, number[]> = {
  calm: [130.81, 196.0, 261.63, 329.63], // C major (C3 G3 C4 E4)
  warm: [110.0, 164.81, 220.0, 329.63], // A minor-open (A2 E3 A3 E4)
};

export interface AmbientOptions {
  mood?: Mood;
  /** Overall gain 0..1 before the wav is written; keep low under narration. */
  gain?: number;
  timeoutMs?: number;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-loglevel", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new MusicError(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(
        error.message.includes("ENOENT")
          ? new MusicError(
              "ffmpeg was not found on PATH. Install ffmpeg, or run without background music (--music=off).",
            )
          : new MusicError(`ffmpeg failed to start: ${error.message}`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new MusicError(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/**
 * Synthesizes a royalty-free ambient pad loop with ffmpeg's signal
 * generators — no bundled audio assets, so installs stay light.
 */
export async function generateAmbientMusic(
  durationMs: number,
  options: AmbientOptions = {},
): Promise<{ audio: Uint8Array; mimeType: "audio/wav"; durationMs: number }> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new MusicError("durationMs must be finite and positive");
  if (options.gain !== undefined && (!Number.isFinite(options.gain) || options.gain < 0 || options.gain > 1)) throw new MusicError("gain must be between 0 and 1");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300_000)) throw new MusicError("timeoutMs must be in (0, 300000]");
  if (options.mood !== undefined && !Object.hasOwn(CHORDS, options.mood)) throw new MusicError("Unknown mood; use calm or warm");
  const durationSec = Math.min(60, Math.max(3, durationMs / 1000));
  const mood = options.mood ?? "calm";
  const gain = Math.min(0.5, options.gain ?? 0.16);
  const chord = CHORDS[mood];
  const expr = chord
    .map(
      (frequency, index) =>
        `${(gain / chord.length).toFixed(4)}*sin(2*PI*${frequency}*t)*(${1 - index * 0.12})`,
    )
    .join("+");
  const audio = await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${expr}:s=44100:d=${durationSec.toFixed(2)}`,
      "-af",
      "tremolo=f=0.35:d=0.55,lowpass=f=1400,afade=t=in:d=1.5",
      "-ac",
      "1",
      "-frame_size",
      "1152",
      "-f",
      "wav",
      "pipe:1",
    ],
    options.timeoutMs ?? 60_000,
  );
  return { audio, mimeType: "audio/wav", durationMs: Math.round(durationSec * 1000) };
}
