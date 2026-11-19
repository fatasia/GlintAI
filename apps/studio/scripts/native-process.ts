import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 受控进程台账：取消/超时排查需要确知归属的原生进程记录。pid 来自本进程
// 自己的 spawn 返回值，绝不来自系统枚举——DELIVER-02 事故（2026-10-27）证明
// 按 PID 枚举推断归属会误伤外部进程，台账只用于只读核查，不用于清理。
let ledgerBroken = false;
export function recordProcessLedger(command: string, pid: number | undefined, args: string[]) {
  const ledger = process.env.GLINT_PROCESS_LEDGER;
  if (!ledger || ledgerBroken || pid === undefined) return;
  try {
    fs.appendFileSync(ledger, JSON.stringify({ pid, command, argv: [command, ...args], at: new Date().toISOString() }) + "\n");
  } catch (error) {
    ledgerBroken = true;
    console.error(`[glint] process ledger disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runMediaProcess(command: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
    recordProcessLedger(command, child.pid, args);
    let stderr = "";
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 180000);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("Operation cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

export function resolveMediaPath(root: string, relative: string): string {
  if (!relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(p => !p || p === "." || p === "..") || /[:\u0000]/.test(relative)) throw new Error("Media must be a safe local relative path");
  const base = fs.realpathSync(root), file = fs.realpathSync(path.resolve(base, relative));
  const delta = path.relative(base, file);
  if (delta.startsWith("..") || path.isAbsolute(delta)) throw new Error("Media path escapes project directory");
  if (!fs.statSync(file).isFile()) throw new Error("Media path is not a file");
  return file;
}

export interface PngEncoder { write(frame: Uint8Array): Promise<void>; finish(): Promise<void>; readonly bytes: number }

/** Streams PNG frames straight into x264 — no per-frame temp files on disk. */
export function startPngEncoder(options: { fps: number; frameRateText?: string; crf: number; preset: string; output: string; signal?: AbortSignal }): PngEncoder {
  options.signal?.throwIfAborted();
  const args = ["-v", "error", "-y", "-f", "image2pipe", "-framerate", options.frameRateText ?? String(options.fps), "-i", "-", "-c:v", "libx264", "-preset", options.preset, "-crf", String(options.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", options.output];
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"], shell: false });
  recordProcessLedger("ffmpeg", child.pid, args);
  let stderr = "", bytes = 0, failed = false, pipeError: Error | undefined;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 600000);
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on("error", error => { pipeError = error; child.kill(); });
    child.once("error", error => { failed = true; clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (pipeError) reject(new Error(`ffmpeg encoder input failed: ${pipeError.message}`));
      else if (options.signal?.aborted || failed) reject(new Error("Encoding cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg encoder failed (${code}): ${stderr}`));
    });
  });
  return {
    write(frame) {
      if (failed || pipeError) return Promise.reject(new Error(pipeError ? `ffmpeg encoder input failed: ${pipeError.message}` : "Encoder already failed"));
      bytes += frame.length;
      return new Promise<void>((resolve, reject) => {
        if (child.stdin.write(frame)) return resolve();
        child.stdin.once("drain", resolve);
      });
    },
    finish: () => new Promise<void>((resolve, reject) => {
      child.stdin.end();
      done.then(() => resolve(), reject);
    }),
    get bytes() { return bytes; },
  };
}
