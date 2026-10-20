import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QwenLocalTtsProvider } from "./qwen";
import { createSilentWav } from "./wav";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-qwen-test-"));
  const referenceAudio = path.join(dir, "reference.wav"); fs.writeFileSync(referenceAudio, createSilentWav(500));
  const children: any[] = [];
  const spawnWorker = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child); return child;
  });
  const provider = new QwenLocalTtsProvider({ python: "trusted-python", modelDir: dir, referenceAudio }, spawnWorker as unknown as typeof spawn);
  cleanups.push(() => { provider.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { provider, children, spawnWorker };
}
it("reuses one worker and correlates replies to pending scenes", async () => {
  const { provider, children, spawnWorker } = setup();
  const first = provider.synthesize({ text: "first" }), second = provider.synthesize({ text: "second" });
  const audio = Buffer.from(createSilentWav(500)).toString("base64");
  children[0].stdout.write(JSON.stringify({ type: "ready" }) + "\n" + JSON.stringify({ id: 2, audio }) + "\n" + JSON.stringify({ id: 1, audio }) + "\n");
  const result = await Promise.all([first, second]);
  expect(spawnWorker).toHaveBeenCalledTimes(1); expect(result[0]!.durationMs).toBe(500);
  expect(result[1]!.words[0]!.text).toBe("second");
  expect((spawnWorker.mock.calls[0] as unknown as [string, string[]])[1].slice(0, 3)).toEqual(["-I", "-X", "utf8"]);
});
it("cancels the worker and rejects all queued scenes", async () => {
  const { provider, children } = setup(), controller = new AbortController();
  const first = provider.synthesize({ text: "one", signal: controller.signal }), second = provider.synthesize({ text: "two" });
  controller.abort();
  await expect(first).rejects.toThrow("cancelled"); await expect(second).rejects.toThrow("cancelled");
  expect(children[0].kill).toHaveBeenCalledTimes(1);
});
it("rejects worker crashes without leaking stderr and does not respawn automatically", async () => {
  const { provider, children, spawnWorker } = setup();
  const result = provider.synthesize({ text: "one" });
  children[0].stderr.write("SECRET"); children[0].emit("close", 1);
  await expect(result).rejects.toThrow("exited");
  await expect(provider.synthesize({ text: "retry" })).rejects.toThrow("stopped");
  expect(spawnWorker).toHaveBeenCalledTimes(1);
});
