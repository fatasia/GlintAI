import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { nleSourceTimeMs } from "@glintai/scenescript";
import { captureProcess } from "./frame-diff";
import { runMediaProcess } from "./native-process";
import { renderNleAudioPart, type NleAudioPart } from "./nle-audio";

const roots: string[] = [];
const rate = 48_000;
const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-retime-")); roots.push(root);
  const pcm = Buffer.alloc(rate * 4 * 8);
  for (let frame = 0; frame < rate * 4; frame++) {
    const seconds = frame / rate;
    pcm.writeFloatLE(seconds / 5, frame * 8);
    pcm.writeFloatLE(-seconds / 10, frame * 8 + 4);
  }
  const source = path.join(root, "source.pcm"), input = path.join(root, "source.wav");
  fs.writeFileSync(source, pcm);
  await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", String(rate), "-i", source, "-c:a", "pcm_f32le", input]);
  return { root, input };
}
async function samples(file: string) {
  return captureProcess("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "2", "-ar", String(rate), "pipe:1"]);
}
function value(bytes: Buffer, ms: number, channel = 0) {
  return bytes.readFloatLE((Math.round(ms / 1000 * rate) * 2 + channel) * 4);
}

describe.skipIf(!available)("NLE retiming real ffmpeg PCM contract", () => {
  for (const curve of ["in", "out", "bell"] as const) it(`${curve} works without a stored ramp and honors source trim, placement and stereo`, async () => {
    const { root, input } = await fixture();
    const part: NleAudioPart = { input, sourceInMs: 500, startMs: 200, durationMs: 1000, speed: 1, volume: 0.8, curve };
    const out = path.join(root, "part.wav");
    await renderNleAudioPart(part, out, 1500);
    const pcm = await samples(out);
    expect(pcm.length / 8).toBe(rate * 1.5);
    expect(value(pcm, 100)).toBe(0); expect(value(pcm, 1300)).toBe(0);
    for (const ms of [100, 250, 500, 750, 950]) {
      const sourceMs = nleSourceTimeMs({ durationMs: 1000, trimStartMs: 500, speedCurve: curve }, ms);
      expect(value(pcm, ms + 200)).toBeCloseTo(sourceMs / 5000 * 0.8, 4);
      expect(value(pcm, ms + 200, 1)).toBeCloseTo(-sourceMs / 10000 * 0.8, 4);
    }
    expect(fs.readdirSync(root).some(name => name.startsWith("nle-audio-"))).toBe(false);
  }, 30_000);

  it("retains fractional source positions after a cropped curve and pads short sources", async () => {
    const { root, input } = await fixture(), out = path.join(root, "cropped.wav");
    const part: NleAudioPart = { input, sourceInMs: 333.375, startMs: 0, durationMs: 600, speed: 1.5, volume: 1, curve: "bell", ramp: { durationMs: 1000, offsetMs: 400 } };
    await renderNleAudioPart(part, out, 600);
    const pcm = await samples(out);
    for (const ms of [50, 200, 500]) {
      const sourceMs = nleSourceTimeMs({ durationMs: 600, trimStartMs: part.sourceInMs, speed: 1.5, speedCurve: "bell", speedRamp: part.ramp }, ms);
      expect(value(pcm, ms)).toBeCloseTo(sourceMs / 5000, 4);
    }
    await renderNleAudioPart({ ...part, sourceInMs: 3900 }, out, 600);
    expect(value(await samples(out), 550)).toBe(0);
  }, 30_000);

  it("constant speed has an exact target duration and failed/cancelled decodes clean temporary files", async () => {
    const { root, input } = await fixture(), out = path.join(root, "linear.wav");
    const part = { input, sourceInMs: 500, startMs: 100, durationMs: 777, speed: 1.7, volume: 1 };
    await renderNleAudioPart(part, out, 1000);
    expect((await samples(out)).length / 8).toBe(rate);
    const controller = new AbortController(); controller.abort();
    await expect(renderNleAudioPart(part, out, 1000, controller.signal)).rejects.toThrow();
    await expect(renderNleAudioPart({ ...part, input: path.join(root, "missing.wav"), curve: "in" }, out, 1000)).rejects.toThrow();
    expect(fs.readdirSync(root).some(name => name.startsWith("nle-audio-"))).toBe(false);
  }, 30_000);
});
