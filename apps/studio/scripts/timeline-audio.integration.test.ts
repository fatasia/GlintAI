import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { createSilentWav } from "@glintai/tts";
import { renderNative } from "./native-render";
import { captureProcess } from "./frame-diff";

const roots: string[] = [];
const sampleRate = 24_000;
const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function toneFixture() {
  const wav = Buffer.from(createSilentWav(1000, sampleRate));
  for (let i = 0; i < sampleRate; i++) {
    const t = i / sampleRate;
    const hz = t < 0.2 ? 0 : t < 0.4 ? 440 : t < 0.6 ? 880 : t < 0.8 ? 1320 : 0;
    wav.writeInt16LE(hz ? Math.round(Math.sin(2 * Math.PI * hz * t) * 9000) : 0, 44 + i * 2);
  }
  return wav;
}

async function render(offset: number, audioScene: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-jl-render-")); roots.push(root);
  fs.writeFileSync(path.join(root, "voice.wav"), toneFixture());
  const project = parseProject({ schemaVersion: 1, id: "jl-render", title: "J/L cut", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [0, 1].map(index => ({
    id: `scene-${index}`, kind: "title", title: `Scene ${index}`, narration: {
      text: "tone", durationMs: 500,
      ...(index === audioScene ? { audioRef: "voice.wav", audioOffsetMs: offset } : {}),
    },
  })) });
  const projectPath = path.join(root, "project.json"), output = path.join(root, "cut.mp4");
  fs.writeFileSync(projectPath, JSON.stringify(project));
  await renderNative({ projectPath, output, tts: "existing", music: "off", fast: true, log: () => {} });
  const bytes = await captureProcess("ffmpeg", ["-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"]);
  const samples = Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
  return { output, samples };
}
function rms(samples: number[], from: number, to: number) {
  const part = samples.slice(Math.round(from * sampleRate), Math.round(to * sampleRate));
  return Math.sqrt(part.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, part.length));
}
function energy(samples: number[], from: number, to: number, hz: number) {
  let real = 0, imaginary = 0;
  const start = Math.round(from * sampleRate), end = Math.round(to * sampleRate);
  for (let index = start; index < end; index++) {
    real += (samples[index] ?? 0) * Math.cos(2 * Math.PI * hz * index / sampleRate);
    imaginary += (samples[index] ?? 0) * Math.sin(2 * Math.PI * hz * index / sampleRate);
  }
  return real * real + imaginary * imaginary;
}

describe.skipIf(!available)("J/L cut encoded-media regression", () => {
  it("clips the source prefix when a J cut precedes composition zero", async () => {
    // Scene 2 starts at 500ms. -700ms means global -200ms, not 0ms with the original prefix.
    const { samples } = await render(-700, 1);
    expect(rms(samples, 0.05, 0.15)).toBeGreaterThan(0.05);
    expect(energy(samples, 0.05, 0.15, 440)).toBeGreaterThan(energy(samples, 0.05, 0.15, 880) * 10);
    expect(energy(samples, 0.25, 0.35, 880)).toBeGreaterThan(energy(samples, 0.25, 0.35, 440) * 10);
  }, 120_000);
  it("preserves the source prefix on a delayed start and continues past the visual boundary", async () => {
    const { samples } = await render(100, 0);
    expect(rms(samples, 0.02, 0.08)).toBeLessThan(0.01);
    expect(rms(samples, 0.15, 0.22)).toBeLessThan(0.01);
    expect(energy(samples, 0.35, 0.45, 440)).toBeGreaterThan(energy(samples, 0.35, 0.45, 880) * 10);
    // Visual scene 1 ended at 500ms: narration must still be playing.
    expect(rms(samples, 0.55, 0.65)).toBeGreaterThan(0.05);
    expect(energy(samples, 0.55, 0.65, 880)).toBeGreaterThan(energy(samples, 0.55, 0.65, 440) * 10);
  }, 120_000);
});
