import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { TtsProvider, TtsRequest, TtsResult } from "./index";
import { parseWavDurationMs } from "./wav";
import { parseMp3DurationMs } from "./mp3";
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function validate(result: TtsResult, request?: TtsRequest) {
  if (!result.audio?.length || result.audio.length > 32 * 1024 * 1024 || !["audio/wav", "audio/mpeg"].includes(result.mimeType) || !Number.isFinite(result.durationMs) || result.durationMs <= 0 || !Array.isArray(result.words) || result.words.some((word) => !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs < word.startMs || word.endMs > result.durationMs + 50)) throw new Error("Invalid TTS result");
  const duration = result.mimeType === "audio/wav" ? parseWavDurationMs(result.audio, 0) : parseMp3DurationMs(result.audio, 0);
  if (!duration || Math.abs(duration - result.durationMs) > Math.max(50, duration * 0.01)) throw new Error("TTS audio duration does not match metadata");
  if (result.words.some(word => typeof word.text !== "string" || word.endMs > duration + 50)) throw new Error("TTS word timing exceeds audio duration");
  if (request && result.words.length) {
    const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const source = normalize(request.text), words = normalize(result.words.map(word => word.text).join(""));
    if (source !== words) throw new Error("TTS words do not match the source text");
  }
}
function cacheDigest(key: string, result: TtsResult): string {
  return digest(JSON.stringify({ version: 3, key, audio: digest(result.audio), mimeType: result.mimeType, durationMs: result.durationMs, words: result.words, diagnostics: result.diagnostics ?? null }));
}
function requestKey(provider: TtsProvider, request: TtsRequest, namespace?: string): string {
  return digest(JSON.stringify({ version: 2, provider: namespace ?? provider.cacheKey ?? `${provider.constructor.name}:${provider.name}`, text: request.text, voice: request.voice, rate: request.speakingRate }));
}
function cachedResult(data: string, key: string, request: TtsRequest): TtsResult {
  const cached = JSON.parse(data);
  const result: TtsResult = { ...cached.result, audio: new Uint8Array(Buffer.from(cached.result.audio, "base64")) };
  validate(result, request);
  if (cached.version !== 3 || cached.key !== key || cached.hash !== cacheDigest(key, result)) throw new Error("Cache mismatch or legacy cache");
  return result;
}
/** Read-only cache lookup: never contacts the provider or creates directories. */
export function readCachedTts(provider: TtsProvider, request: TtsRequest, cacheDir: string, namespace?: string): TtsResult | undefined {
  const key = requestKey(provider, request, namespace), file = path.join(cacheDir, `${key}.json`);
  try {
    if (statSync(file).size > 48 * 1024 * 1024) return undefined;
    return cachedResult(readFileSync(file, "utf8"), key, request);
  } catch { return undefined; }
}

/** Bounded workers, cancellation and a local content-addressed cache. Failed batches abort siblings. */
export async function synthesizeBatch(provider: TtsProvider, requests: TtsRequest[], options: {
  concurrency?: number; cacheDir?: string; cacheNamespace?: string; signal?: AbortSignal; cacheOnly?: boolean; onProviderCall?: () => void;
} = {}): Promise<TtsResult[]> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("TTS concurrency must be 1..8");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const results: TtsResult[] = [];
  const inflight = new Map<string, Promise<TtsResult>>();
  if (options.cacheOnly && !options.cacheDir) throw new Error("TTS cache-only mode requires a cache directory");
  if (options.cacheDir && !options.cacheOnly) await fs.mkdir(options.cacheDir, { recursive: true });
  let next = 0;
  let failure: unknown;
  const run = async (request: TtsRequest) => {
    const combined = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
    combined.throwIfAborted();
    // version 2: a provider's own cacheKey (model/voice/parser revision) is now
    // mandatory in spirit — when it is missing we at least separate provider
    // classes, so a different implementation can never reuse stale audio.
    const key = requestKey(provider, request, options.cacheNamespace);
    // Requests with independent cancellation must not share an upstream request.
    const existing = !request.signal && inflight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const file = options.cacheDir && path.join(options.cacheDir, `${key}.json`);
      if (file) try {
        const stat = await fs.stat(file);
        if (stat.size > 48 * 1024 * 1024) throw new Error("Oversized cache entry");
        const result = cachedResult(await fs.readFile(file, "utf8"), key, request);
        combined.throwIfAborted();
        return result;
      } catch (error) { combined.throwIfAborted(); /* Cache misses/corruption re-synthesize. */ }
      if (options.cacheOnly) throw new Error("TTS cache changed or is unavailable; retry without --assert-budget to regenerate it");
      options.onProviderCall?.();
      const result = await provider.synthesize({ ...request, signal: combined });
      combined.throwIfAborted(); validate(result, request);
      if (file) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 3, key, hash: cacheDigest(key, result), result: { ...result, audio: Buffer.from(result.audio).toString("base64") } }));
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
