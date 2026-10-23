import { describe, expect, it } from "vitest";
import { generateSfx, generateSynthMusic, SFX_EFFECTS, synthFingerprint, createRandom } from "./synth";

describe("generateSynthMusic", () => {
  const wav = (options?: Parameters<typeof generateSynthMusic>[1]) => generateSynthMusic(4000, options);

  it("emits a valid 44.1k stereo PCM wav header", () => {
    const { audio } = wav();
    const view = Buffer.from(audio);
    expect(view.toString("ascii", 0, 4)).toBe("RIFF");
    expect(view.toString("ascii", 8, 12)).toBe("WAVE");
    expect(view.readUInt32LE(24)).toBe(44100);
    expect(view.readUInt16LE(22)).toBe(2);
    // ~4s at 44100Hz stereo 16-bit + 44 byte header.
    expect(audio.length).toBeGreaterThan(44100 * 2 * 2 * 3);
    expect(audio.length).toBeLessThan(44100 * 2 * 2 * 5);
  });

  it("is deterministic per seed and diverges across seeds/moods", () => {
    const a = synthFingerprint(wav({ seed: 42 }).audio);
    const b = synthFingerprint(wav({ seed: 42 }).audio);
    const c = synthFingerprint(wav({ seed: 43 }).audio);
    const d = synthFingerprint(wav({ seed: 42, mood: "bright" }).audio);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("silences fully at the tail (fade-out) and clamps out-of-range bpm", () => {
    const { audio } = wav();
    const view = Buffer.from(audio);
    const frames = (audio.length - 44) / 4;
    const lastLeft = view.readInt16LE(44 + (frames - 3) * 4);
    expect(Math.abs(lastLeft)).toBeLessThan(600);
    expect(() => generateSynthMusic(0)).toThrow();
    // bpm clamps to 60..140 instead of throwing; tempo still changes output.
    expect(() => generateSynthMusic(4000, { bpm: 10 })).not.toThrow();
    expect(synthFingerprint(wav({ bpm: 10 }).audio)).not.toBe(synthFingerprint(wav().audio));
  });
});

describe("generateSfx", () => {
  it("covers six effects with plausible lengths", () => {
    for (const effect of SFX_EFFECTS) {
      const { audio, durationMs } = generateSfx(effect);
      expect(audio.length).toBeGreaterThan(1000);
      // 0.05s click .. 1.2s riser, ±10% header slack.
      expect(durationMs).toBeGreaterThan(30);
      expect(durationMs).toBeLessThan(1400);
    }
  });

  it("is deterministic per seed and gain affects amplitude", () => {
    const a = synthFingerprint(generateSfx("impact", { seed: 5 }).audio);
    const b = synthFingerprint(generateSfx("impact", { seed: 5 }).audio);
    const c = synthFingerprint(generateSfx("impact", { seed: 6 }).audio);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const quiet = Buffer.from(generateSfx("impact", { gain: 0.1 }).audio);
    const loud = Buffer.from(generateSfx("impact", { gain: 0.9 }).audio);
    const peak = (buffer: Buffer) => {
      let max = 0;
      for (let i = 44; i < buffer.length - 1; i += 2) max = Math.max(max, Math.abs(buffer.readInt16LE(i)));
      return max;
    };
    expect(peak(loud)).toBeGreaterThan(peak(quiet));
  });
});

describe("createRandom", () => {
  it("is seed-stable and stays in 0..1", () => {
    const a = createRandom(9), b = createRandom(9);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
