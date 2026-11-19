import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseMp3DurationMs } from "./mp3";
import { parseWavDurationMs } from "./wav";

it("accepts measurable PCM and rejects real ADPCM, gapless MP3 and truncated MP3", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-audio-format-"));
  try {
    const make = (name: string, codec: string, extra: string[] = []) => {
      const file = path.join(root, name);
      const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1:sample_rate=44100", "-c:a", codec, ...extra, "-y", file], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0); return fs.readFileSync(file);
    };
    expect(parseWavDurationMs(make("pcm.wav", "pcm_s16le"), 0)).toBe(1000);
    expect(parseWavDurationMs(make("adpcm.wav", "adpcm_ima_wav"), 0)).toBe(0);
    const gapless = make("gapless.mp3", "libmp3lame");
    expect(parseMp3DurationMs(gapless, 0)).toBe(0);
    const plain = make("plain.mp3", "libmp3lame", ["-write_xing", "0", "-id3v2_version", "0"]);
    expect(parseMp3DurationMs(plain, 0)).toBeGreaterThan(0);
    for (const missing of [1, 4, 40, 100, 127]) expect(parseMp3DurationMs(plain.subarray(0, plain.length - missing), 0)).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
