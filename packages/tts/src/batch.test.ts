import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockTtsProvider, createSilentWav, parseWavDurationMs, type TtsRequest } from "./index";
import { createHash } from "node:crypto";
import { synthesizeBatch, readCachedTts } from "./batch";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
it("bounds workers and preserves order", async () => {
  let active = 0, peak = 0;
  const mock = new MockTtsProvider();
  const provider = { name: "test", synthesize: async (request: TtsRequest) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return mock.synthesize(request);
  } };
  const requests = ["one", "two two", "three three three", "four"].map((text) => ({ text }));
  const results = await synthesizeBatch(provider, requests, { concurrency: 2 });
  expect(peak).toBe(2); expect(results.map((result) => result.words[0]!.text)).toEqual(["one", "two", "three", "four"]);
});
it("deduplicates and reuses content-addressed entries, with voice and provider isolation", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-tts-test-")); dirs.push(cacheDir);
  const mock = new MockTtsProvider(), synthesize = vi.fn((request) => mock.synthesize(request));
  const provider = { name: "test", synthesize };
  await synthesizeBatch(provider, [{ text: "hello" }, { text: "hello" }], { cacheDir });
  await synthesizeBatch(provider, [{ text: "hello" }], { cacheDir });
  expect(synthesize).toHaveBeenCalledTimes(1);
  await synthesizeBatch(provider, [{ text: "hello", voice: "other" }], { cacheDir });
  await synthesizeBatch(provider, [{ text: "hello" }], { cacheDir, cacheNamespace: "other-model" });
  expect(synthesize).toHaveBeenCalledTimes(3);
  const file = (await fs.readdir(cacheDir))[0]!;
  await fs.writeFile(path.join(cacheDir, file), "corrupt");
  await synthesizeBatch(provider, [{ text: "hello" }, { text: "hello", voice: "other" }], { cacheDir });
  expect(synthesize.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it("never synthesizes in cache-only mode after eviction or corruption", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-tts-cache-only-")); dirs.push(cacheDir);
  const mock = new MockTtsProvider(), synthesize = vi.fn((request) => mock.synthesize(request));
  const provider = { name: "cache-only", synthesize };
  await expect(synthesizeBatch(provider, [{ text: "hello" }], { cacheDir, cacheOnly: true })).rejects.toThrow(/cache changed/);
  expect(synthesize).not.toHaveBeenCalled();
  await synthesizeBatch(provider, [{ text: "hello" }], { cacheDir });
  expect(readCachedTts(provider, { text: "hello" }, cacheDir)?.durationMs).toBeGreaterThan(0);
  expect(readCachedTts(provider, { text: "hello", voice: "other" }, cacheDir)).toBeUndefined();
  await fs.writeFile(path.join(cacheDir, (await fs.readdir(cacheDir))[0]!), "corrupt");
  expect(readCachedTts(provider, { text: "hello" }, cacheDir)).toBeUndefined();
  await expect(synthesizeBatch(provider, [{ text: "hello" }], { cacheDir, cacheOnly: true })).rejects.toThrow(/cache changed/);
  expect(synthesize).toHaveBeenCalledTimes(1);
});
it("rejects a forged metadata hash when audio duration differs", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-tts-duration-")); dirs.push(cacheDir);
  const provider = new MockTtsProvider();
  await synthesizeBatch(provider, [{ text: "hello" }], { cacheDir });
  const file = path.join(cacheDir, (await fs.readdir(cacheDir))[0]!);
  const cached = JSON.parse(await fs.readFile(file, "utf8"));
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const audio = Buffer.from(cached.result.audio, "base64");
  const hash = () => digest(JSON.stringify({ version: 3, key: cached.key, audio: digest(audio), mimeType: cached.result.mimeType, durationMs: cached.result.durationMs, words: cached.result.words, diagnostics: cached.result.diagnostics ?? null }));
  cached.result.words[0].text = "forged"; cached.hash = hash();
  await fs.writeFile(file, JSON.stringify(cached));
  expect(readCachedTts(provider, { text: "hello" }, cacheDir)).toBeUndefined();
  cached.result.words[0].text = "hello";
  cached.result.durationMs += 2000;
  cached.hash = hash();
  await fs.writeFile(file, JSON.stringify(cached));
  expect(readCachedTts(provider, { text: "hello" }, cacheDir)).toBeUndefined();
  const bad = { name: "bad", synthesize: async () => ({ audio: createSilentWav(1000), mimeType: "audio/wav" as const, durationMs: 3000, words: [] }) };
  await expect(synthesizeBatch(bad, [{ text: "hello" }])).rejects.toThrow(/duration/);
});
it("rejects compressed or truncated WAV instead of guessing duration", () => {
  const wav = createSilentWav(1000);
  expect(parseWavDurationMs(wav, 0)).toBe(1000);
  const adpcm = wav.slice(); new DataView(adpcm.buffer).setUint16(20, 17, true);
  expect(parseWavDurationMs(adpcm, 0)).toBe(0);
  expect(parseWavDurationMs(wav.subarray(0, wav.length - 1), 0)).toBe(0);
});
it("aborts sibling work on failure and writes no cancelled cache entries", async () => {
  let aborted = false;
  const provider = { name: "failure", synthesize: async (request: TtsRequest) => {
    if (request.text === "bad") throw new Error("provider failed");
    return new Promise<never>((_, reject) => request.signal!.addEventListener("abort", () => { aborted = true; reject(request.signal!.reason); }, { once: true }));
  } };
  await expect(synthesizeBatch(provider, [{ text: "slow" }, { text: "bad" }])).rejects.toThrow("provider failed");
  expect(aborted).toBe(true);
  const controller = new AbortController(); controller.abort();
  await expect(synthesizeBatch(new MockTtsProvider(), [{ text: "x" }], { signal: controller.signal })).rejects.toThrow();
});
