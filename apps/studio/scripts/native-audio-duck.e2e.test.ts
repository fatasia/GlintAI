import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseProject } from "@glintai/scenescript";
import { prepareNativeAudio } from "./native-audio";
import { renderNative } from "./native-render";

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
}
function amplitude(file: string, frequency: number, start: number, duration: number): number {
  const result = spawnSync("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(duration), "-i", file, "-ac", "1", "-ar", "44100", "-f", "f32le", "-"], { maxBuffer: 4_000_000 });
  expect(result.status, String(result.stderr)).toBe(0);
  const bytes = result.stdout, samples = bytes.length / 4;
  expect(samples).toBeGreaterThan(1000);
  let re = 0, im = 0;
  for (let i = 0; i < samples; i++) { const sample = bytes.readFloatLE(i * 4), angle = 2 * Math.PI * frequency * i / 44100; re += sample * Math.cos(angle); im += sample * Math.sin(angle); }
  return 2 * Math.hypot(re, im) / samples;
}

it("retains narration in mixed audio and ducks music only while speech is present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-voice-duck-"));
  try {
    const voice = path.join(root, "voice.wav"), music = path.join(root, "music.wav");
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=1500:sample_rate=44100:duration=1", "-af", "volume=4", "-y", voice]);
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=2", "-y", music]);
    const project = parseProject({ schemaVersion: 1, id: "voice-test", title: "Voice", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "voice", audioRef: "voice.wav", durationMs: 2000, audioOffsetMs: 500 } }] });
    const soloDir = path.join(root, "solo"), mixedDir = path.join(root, "mixed"), synthDir = path.join(root, "synth");
    for (const dir of [soloDir, mixedDir, synthDir]) fs.mkdirSync(dir);
    const solo = await prepareNativeAudio(project, root, soloDir, { tts: "existing", music: "off", noCache: true });
    const mixed = await prepareNativeAudio(project, root, mixedDir, { tts: "existing", music, noCache: true });
    const synth = await prepareNativeAudio(project, root, synthDir, { tts: "existing", music: "synth", noCache: true });
    const voiceSolo = amplitude(solo.audioPath!, 1500, 0.9, 0.2);
    const voiceMixed = amplitude(mixed.audioPath!, 1500, 0.9, 0.2);
    const voiceSynth = amplitude(synth.audioPath!, 1500, 0.9, 0.2);
    const before = amplitude(mixed.audioPath!, 300, 0.1, 0.2), during = amplitude(mixed.audioPath!, 300, 0.9, 0.2);
    expect(voiceSolo).toBeGreaterThan(0.1);
    expect(voiceMixed / voiceSolo).toBeGreaterThan(0.85);
    expect(voiceSynth / voiceSolo).toBeGreaterThan(0.85);
    expect(before).toBeGreaterThan(0.005);
    expect(during).toBeLessThan(before * 0.7);
    const after = amplitude(mixed.audioPath!, 300, 1.75, 0.15);
    expect(after).toBeGreaterThan(during * 1.1);
    expect(after).toBeGreaterThan(before * 0.2);
    expect(amplitude(mixed.audioPath!, 1500, 0.1, 0.2)).toBeLessThan(0.005);
    const plateDir = path.join(root, "plate"), emptyDir = path.join(root, "empty"); fs.mkdirSync(plateDir); fs.mkdirSync(emptyDir);
    const plate = await prepareNativeAudio(project, root, plateDir, { tts: "existing", music, plate: true, noCache: true });
    expect(amplitude(plate.audioPath!, 1500, 0.9, 0.2) / voiceSolo).toBeGreaterThan(0.85);
    expect(amplitude(plate.audioPath!, 300, 0.1, 0.2)).toBeLessThan(0.005);
    const empty = await prepareNativeAudio(project, root, emptyDir, { tts: "mock", music: "off", noCache: true });
    expect(empty.audioPath).toBeUndefined();
    const projectPath = path.join(root, "project.json"), output = path.join(root, "render.mp4");
    fs.writeFileSync(projectPath, JSON.stringify(project));
    const rendered = await renderNative({ projectPath, output, tts: "existing", music: "synth", fast: true, resolution: "540", noCache: true, log: () => {} });
    expect(amplitude(rendered.output, 1500, 0.9, 0.2) / voiceSolo).toBeGreaterThan(0.7);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
