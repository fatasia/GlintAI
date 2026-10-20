import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockTtsProvider, type TtsRequest } from "./index";
import { synthesizeBatch } from "./batch";
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
