import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TtsProvider, TtsRequest, TtsResult } from "./index";
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function validate(result: TtsResult) {
  if (!result.audio?.length || result.audio.length > 32 * 1024 * 1024 || !["audio/wav", "audio/mpeg"].includes(result.mimeType) || !Number.isFinite(result.durationMs) || result.durationMs <= 0 || !Array.isArray(result.words) || result.words.some((word) => !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs < word.startMs)) throw new Error("Invalid TTS result");
}
/** Bounded workers, cancellation and a local content-addressed cache. Failed batches abort siblings. */
export async function synthesizeBatch(provider: TtsProvider, requests: TtsRequest[], options: {
  concurrency?: number; cacheDir?: string; cacheNamespace?: string; signal?: AbortSignal;
} = {}): Promise<TtsResult[]> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("TTS concurrency must be 1..8");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const results: TtsResult[] = [];
  const inflight = new Map<string, Promise<TtsResult>>();
  if (options.cacheDir) await fs.mkdir(options.cacheDir, { recursive: true });
  let next = 0;
  let failure: unknown;
  const run = async (request: TtsRequest) => {
    const combined = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
    combined.throwIfAborted();
    // version 2: a provider's own cacheKey (model/voice/parser revision) is now
    // mandatory in spirit — when it is missing we at least separate provider
    // classes, so a different implementation can never reuse stale audio.
    const key = digest(JSON.stringify({ version: 2, provider: options.cacheNamespace ?? provider.cacheKey ?? `${provider.constructor.name}:${provider.name}`, text: request.text, voice: request.voice, rate: request.speakingRate }));
    // Requests with independent cancellation must not share an upstream request.
    const existing = !request.signal && inflight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const file = options.cacheDir && path.join(options.cacheDir, `${key}.json`);
      if (file) try {
        const stat = await fs.stat(file);
        if (stat.size > 48 * 1024 * 1024) throw new Error("Oversized cache entry");
        const cached = JSON.parse(await fs.readFile(file, "utf8"));
        const result: TtsResult = { ...cached.result, audio: new Uint8Array(Buffer.from(cached.result.audio, "base64")) };
        validate(result);
        if (cached.key !== key || cached.hash !== digest(result.audio)) throw new Error("Cache mismatch");
        combined.throwIfAborted();
        return result;
      } catch (error) { combined.throwIfAborted(); /* Cache misses/corruption re-synthesize. */ }
      const result = await provider.synthesize({ ...request, signal: combined });
      combined.throwIfAborted(); validate(result);
      if (file) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ key, hash: digest(result.audio), result: { ...result, audio: Buffer.from(result.audio).toString("base64") } }));
          combined.throwIfAborted();
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      return result;
    })();
    if (!request.signal) inflight.set(key, task);
    return task;
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    try {
      while (next < requests.length) {
        signal.throwIfAborted();
        const index = next++;
        results[index] = await run(requests[index]!);
      }
    } catch (error) { if (!failure) failure = error; controller.abort(error); }
  }));
  if (failure) throw failure;
  signal.throwIfAborted();
  return results;
}
