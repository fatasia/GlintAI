import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateWordTimings } from "@glintai/scenescript";
import { parseWavDurationMs } from "./wav";
import type { TtsProvider, TtsRequest, TtsResult } from "./index";
export interface QwenLocalTtsConfig { python: string; modelDir: string; referenceAudio: string; referenceText?: string; timeoutMs?: number; measureQuality?: boolean }
/** Opt-in worker: load the local model/reference prompt once, then reuse them across scenes. */
export class QwenLocalTtsProvider implements TtsProvider {
  readonly name = "qwen3-tts-local";
  readonly cacheKey: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private buffer = "";
  private stopped = false;
  private pending = new Map<number, { resolve(result: TtsResult): void; reject(error: Error): void; text: string; cleanup(): void }>();
  constructor(private readonly config: QwenLocalTtsConfig, private readonly spawnWorker: typeof spawn = spawn) {
    if (!fs.statSync(config.modelDir).isDirectory() || !fs.statSync(config.referenceAudio).isFile()) throw new Error("Local Qwen model and reference audio are required");
    if (fs.statSync(config.referenceAudio).size > 10 * 1024 * 1024) throw new Error("Reference audio exceeds 10 MiB");
    const modelFiles = fs.readdirSync(config.modelDir).filter((file) => /(?:\.json|\.safetensors)$/.test(file)).sort().map((file) => {
      const stat = fs.statSync(path.join(config.modelDir, file)); return [file, stat.size, stat.mtimeMs];
    });
    this.cacheKey = createHash("sha256").update(JSON.stringify([this.name, 1, path.resolve(config.modelDir), modelFiles, config.referenceText ?? ""])).update(fs.readFileSync(config.referenceAudio)).digest("hex");
  }
  private stop(error: Error) {
    this.stopped = true;
    const child = this.child; this.child = null;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear(); child?.kill();
  }
  private start() {
    if (this.stopped) throw new Error("Qwen worker is stopped");
    if (this.child) return this.child;
    const child = this.spawnWorker(this.config.python, ["-I", "-X", "utf8", fileURLToPath(new URL("../adapters/qwen_clone.py", import.meta.url))], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    this.child = child;
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.stop(new Error("Qwen input stream failed")));
    child.once("error", () => this.stop(new Error("Cannot start Qwen worker. Check the optional Python environment.")));
    child.once("close", () => { if (this.child === child) this.stop(new Error("Qwen worker exited before completing synthesis")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 48 * 1024 * 1024) return this.stop(new Error("Qwen response exceeds limit"));
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "ready") continue;
          if (message.type === "error") throw new Error("Local Qwen synthesis failed. Check model files, optional dependencies and reference audio.");
          const entry = this.pending.get(message.id);
          if (!entry || typeof message.audio !== "string") throw new Error("Invalid Qwen response");
          const audio = new Uint8Array(Buffer.from(message.audio, "base64")), durationMs = parseWavDurationMs(audio, 0);
          if (!audio.length || durationMs <= 0) throw new Error("Invalid Qwen WAV output");
          this.pending.delete(message.id); entry.cleanup();
          entry.resolve({ audio, durationMs, mimeType: "audio/wav", words: estimateWordTimings(entry.text, durationMs), diagnostics: message.diagnostics });
        } catch (error) { this.stop(error instanceof Error ? error : new Error("Invalid Qwen output")); return; }
      }
    });
    child.stdin.write(JSON.stringify({ modelDir: path.resolve(this.config.modelDir), referenceAudio: path.resolve(this.config.referenceAudio), referenceText: this.config.referenceText, measureQuality: this.config.measureQuality }) + "\n");
    return child;
  }
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    request.signal?.throwIfAborted();
    if (!request.text.trim() || request.text.length > 10000) throw new Error("Qwen narration must be 1..10000 characters");
    if (request.voice || (request.speakingRate !== undefined && request.speakingRate !== 1)) throw new Error("Local Qwen uses its configured reference voice and native speed");
    const child = this.start(), id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => this.stop(new Error("Qwen synthesis cancelled"));
      const timer = setTimeout(() => this.stop(new Error("Qwen synthesis timed out")), request.timeoutMs ?? this.config.timeoutMs ?? 300_000);
      const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, text: request.text, cleanup });
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) return abort();
      child.stdin.write(JSON.stringify({ id, text: request.text, language: /[\u3400-\u9fff]/.test(request.text) ? "Chinese" : "English" }) + "\n");
    });
  }
  dispose() { this.stop(new Error("Qwen worker disposed")); }
}
