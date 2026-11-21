import { spawn } from "node:child_process";
import { killMediaProcess } from "./native-process";

// Match reference-video's direct-container policy: no playlists or network protocols.
export const LOOK_LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,flv,ogg"];

/** Bounded capture for small probe/diagnostic text, never decoded media bytes. */
export function captureLook(command: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; killMediaProcess(child); };
    const abort = () => stop(new Error("Look cancelled"));
    const timer = setTimeout(() => stop(new Error("Look media process timed out")), 180_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { stop(new Error("Look diagnostic output exceeds 4 MiB")); return; }
      if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, "stdout"));
    child.stderr.on("data", chunk => collect(chunk, "stderr"));
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${code}); verify the local media is decodable`));
      else resolve({ stdout, stderr });
    });
  });
}

export interface LookInterval { start: number; end: number }
export function parseLookDiagnostics(text: string, duration: number, hasAudio: boolean) {
  const black: LookInterval[] = [], silence: LookInterval[] = [];
  for (const match of text.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    black.push({ start: Number(match[1]), end: Math.min(duration, Number(match[2])) });
  }
  let start: number | undefined;
  for (const match of text.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if (match[1] === "start") start = Number(match[2]);
    else { silence.push({ start: start ?? 0, end: Math.min(duration, Number(match[2])) }); start = undefined; }
  }
  if (start !== undefined) silence.push({ start, end: duration });
  const peaks = [...text.matchAll(/Peak level dB:\s*(-?inf|[-\d.]+)/g)].map(match => Number(match[1])).filter(Number.isFinite);
  const samplePeakDbfs = peaks.length ? Math.max(...peaks) : null;
  return { black, silence, audio: hasAudio ? "present" : "absent", samplePeakDbfs,
    nearFullScale: samplePeakDbfs !== null && samplePeakDbfs >= -0.1,
    note: "Near-full-scale samples are a clipping risk, not proof of clipping or a true-peak measurement. Black/silent intervals may be intentional." };
}

export async function diagnoseLook(file: string, duration: number, hasAudio: boolean, signal?: AbortSignal) {
  const args = ["-nostdin", "-v", "info", ...LOOK_LOCAL_INPUT, "-i", file, "-t", String(duration), "-map", "0:v:0", "-vf", "blackdetect=d=0.2:pix_th=0.1:pic_th=0.98"];
  if (hasAudio) args.push("-map", "0:a:0", "-af", "silencedetect=noise=-50dB:d=0.2,astats=metadata=0:reset=0");
  args.push("-f", "null", "-");
  return parseLookDiagnostics((await captureLook("ffmpeg", args, signal)).stderr, duration, hasAudio);
}
