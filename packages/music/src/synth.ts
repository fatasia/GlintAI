import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { MusicError } from "./index";

/**
 * Offline, dependency-free audio synthesis: deterministic code-composed
 * background music and one-shot SFX, written straight to WAV. No sample
 * packs, no network — the "no gateway configured" tier of the audio system.
 * All randomness flows through the seeded PRNG so identical inputs produce
 * byte-identical output (render determinism red line).
 */

const SAMPLE_RATE = 44100;

/** mulberry32 — small, fast, seed-stable. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeWav(channels: [Float32Array, Float32Array]): Uint8Array {
  const frames = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = channels.length * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels.length, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      const clamped = Math.max(-1, Math.min(1, channels[channel]![frame]!));
      buffer.writeInt16LE(Math.round(clamped * 32767), 44 + frame * blockAlign + channel * bytesPerSample);
    }
  }
  return new Uint8Array(buffer);
}

const envelope = (t: number, attack: number, release: number, length: number) => {
  if (t < attack) return t / attack;
  if (t > length - release) return Math.max(0, (length - t) / release);
  return 1;
};

type Voice = { start: number; length: number; frequency: number; gain: number; wave: "sine" | "triangle" | "saw"; pan: number };

function renderVoices(durationSec: number, voices: Voice[]): [Float32Array, Float32Array] {
  const frames = Math.ceil(durationSec * SAMPLE_RATE);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  // One shared lowpass state per voice approximates the saw's brightness rolloff
  // without a filter dependency; coefficient fixed for a soft, bed-like tone.
  for (const voice of voices) {
    const startFrame = Math.floor(voice.start * SAMPLE_RATE);
    const voiceFrames = Math.ceil(voice.length * SAMPLE_RATE);
    let phase = 0, lowpassed = 0;
    const panLeft = Math.min(1, 1 - voice.pan), panRight = Math.min(1, 1 + voice.pan);
    for (let i = 0; i < voiceFrames && startFrame + i < frames; i++) {
      const t = i / SAMPLE_RATE;
      phase += voice.frequency / SAMPLE_RATE;
      if (phase >= 1) phase -= 1;
      const raw = voice.wave === "sine" ? Math.sin(phase * Math.PI * 2)
        : voice.wave === "triangle" ? 1 - 4 * Math.abs(Math.round(phase) - phase)
        : 2 * phase - 1;
      lowpassed += (raw - lowpassed) * 0.22;
      const sample = (voice.wave === "saw" ? lowpassed : raw) *
        voice.gain * envelope(t, 0.02, Math.min(0.8, voice.length * 0.4), voice.length);
      left[startFrame + i]! += sample * panLeft * 0.7;
      right[startFrame + i]! += sample * panRight * 0.7;
    }
  }
  return [left, right];
}

export type SynthMood = "calm" | "warm" | "bright";

const PROGRESSIONS: Record<SynthMood, number[][]> = {
  // Chord roots as MIDI-ish semitone offsets from A2 (110 Hz), pentatonic-friendly.
  calm: [[0, 7, 12, 16], [-3, 4, 9, 12], [-5, 2, 7, 11], [-1, 4, 7, 14]],
  warm: [[-3, 4, 9, 12], [-5, 2, 7, 11], [0, 7, 12, 16], [2, 5, 9, 14]],
  bright: [[0, 7, 12, 19], [-1, 4, 7, 14], [-5, 2, 7, 11], [0, 7, 12, 16]],
};

const midiToHz = (semitone: number) => 110 * Math.pow(2, semitone / 12);

export interface SynthMusicOptions {
  seed?: number;
  mood?: SynthMood;
  bpm?: number;
  gain?: number;
}

/**
 * Sectioned bed: intro pad → pulse + arpeggio → outro pad, chords from the
 * mood's progression, arpeggio notes chosen by the seeded PRNG on the chord
 * tones. Bar grid keeps everything on tempo; duration truncates the last bar.
 */
export function generateSynthMusic(durationMs: number, options: SynthMusicOptions = {}): { audio: Uint8Array; mimeType: "audio/wav"; durationMs: number; seed: number } {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new MusicError("durationMs must be finite and positive");
  const durationSec = Math.min(600, Math.max(2, durationMs / 1000));
  const seed = options.seed ?? 42;
  const mood = options.mood ?? "calm";
  const bpm = Math.min(140, Math.max(60, options.bpm ?? 84));
  const gain = Math.min(0.5, options.gain ?? 0.3);
  const random = createRandom(seed);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const progression = PROGRESSIONS[mood];
  const voices: Voice[] = [];
  const totalBars = Math.ceil(durationSec / bar);
  for (let index = 0; index < totalBars; index++) {
    const chord = progression[index % progression.length]!;
    const barStart = index * bar;
    const inPulse = index > 0;
    // Pad: sustained chord tones; the seed jitters octave lift and pan so
    // even pad-only intros differ across seeds.
    for (const [tone, semitone] of chord.entries()) {
      voices.push({
        start: barStart, length: bar, frequency: midiToHz(semitone + 12 + (random() < 0.25 ? 12 : 0)),
        gain: gain * 0.16 * (1 - tone * 0.12), wave: tone < 2 ? "sine" : "triangle",
        pan: (tone % 2 ? 0.25 : -0.25) + (random() - 0.5) * 0.2,
      });
    }
    if (inPulse) {
      // Bass pulse on beats 1 and 3.
      voices.push({ start: barStart, length: beat * 0.9, frequency: midiToHz(chord[0]!), gain: gain * 0.5, wave: "saw", pan: 0 });
      voices.push({ start: barStart + beat * 2, length: beat * 0.9, frequency: midiToHz(chord[0]!), gain: gain * 0.42, wave: "saw", pan: 0 });
      // Arpeggio on eighth notes; rests make it breathe.
      for (let step = 0; step < 8; step++) {
        if (random() < 0.3) continue;
        const tone = chord[Math.floor(random() * chord.length)]! + (random() < 0.3 ? 24 : 12);
        voices.push({
          start: barStart + step * beat * 0.5, length: beat * 0.45,
          frequency: midiToHz(tone), gain: gain * (0.2 + random() * 0.14),
          wave: "triangle", pan: (random() - 0.5) * 0.7,
        });
      }
    }
  }
  const [left, right] = renderVoices(durationSec, voices);
  // Global fade in/out keeps loop points clean under narration.
  const fade = Math.min(1.5, durationSec * 0.1);
  for (let frame = 0; frame < left.length; frame++) {
    const t = frame / SAMPLE_RATE;
    const fadeGain = t < fade ? t / fade : t > durationSec - fade ? Math.max(0, (durationSec - t) / fade) : 1;
    left[frame] = left[frame]! * fadeGain;
    right[frame] = right[frame]! * fadeGain;
  }
  return { audio: encodeWav([left, right]), mimeType: "audio/wav", durationMs: Math.round(durationSec * 1000), seed };
}

export type SfxEffect = "impact" | "whoosh" | "sparkle" | "click" | "pop" | "riser";

const SFX_LENGTH_SEC: Record<SfxEffect, number> = {
  impact: 0.5, whoosh: 0.6, sparkle: 0.9, click: 0.05, pop: 0.12, riser: 1.2,
};

export function generateSfx(effect: SfxEffect, options: { seed?: number; gain?: number } = {}): { audio: Uint8Array; mimeType: "audio/wav"; durationMs: number } {
  const length = SFX_LENGTH_SEC[effect];
  const gain = Math.min(1, Math.max(0, options.gain ?? 0.7));
  const random = createRandom((options.seed ?? 7) + effect.length * 131);
  // ±8% pitch jitter so repeated cues never sound machine-identical.
  const jitter = (base: number) => base * (1 + (random() - 0.5) * 0.16);
  const voices: Voice[] = [];
  switch (effect) {
    case "impact":
      voices.push({ start: 0, length, frequency: jitter(72), gain: gain * 0.9, wave: "sine", pan: 0 });
      voices.push({ start: 0, length: 0.12, frequency: jitter(190), gain: gain * 0.4, wave: "triangle", pan: 0 });
      break;
    case "whoosh":
      voices.push({ start: 0, length, frequency: jitter(midiToHz(-5 + Math.floor(random() * 3))), gain: gain * 0.5, wave: "saw", pan: -0.4 });
      voices.push({ start: length * 0.2, length: length * 0.8, frequency: jitter(midiToHz(2)), gain: gain * 0.35, wave: "saw", pan: 0.4 });
      break;
    case "sparkle":
      for (let index = 0; index < 7; index++) {
        voices.push({
          start: index * 0.09, length: 0.34,
          frequency: jitter(midiToHz(24 - index * 2 + (random() < 0.4 ? 2 : 0))),
          gain: gain * 0.3, wave: "sine", pan: (index / 6 - 0.5) * 0.9,
        });
      }
      break;
    case "click":
      voices.push({ start: 0, length, frequency: jitter(1400), gain: gain * 0.8, wave: "triangle", pan: 0 });
      break;
    case "pop":
      voices.push({ start: 0, length, frequency: jitter(210), gain: gain * 0.85, wave: "sine", pan: 0 });
      break;
    case "riser":
      voices.push({ start: 0, length, frequency: jitter(midiToHz(7)), gain: gain * 0.5, wave: "saw", pan: 0 });
      voices.push({ start: length * 0.35, length: length * 0.65, frequency: jitter(midiToHz(14)), gain: gain * 0.4, wave: "triangle", pan: 0 });
      break;
  }
  // Rising pitch for the riser: superimpose a detuned copy.
  if (effect === "riser") {
    voices.push({ start: 0, length, frequency: jitter(midiToHz(9)), gain: gain * 0.35, wave: "saw", pan: 0.15 });
  }
  const [left, right] = renderVoices(length, voices);
  return { audio: encodeWav([left, right]), mimeType: "audio/wav", durationMs: Math.round(length * 1000) };
}

export const SFX_EFFECTS: SfxEffect[] = ["impact", "whoosh", "sparkle", "click", "pop", "riser"];

/** Deterministic fingerprint — used by tests to pin the PRNG contract. */
export function synthFingerprint(audio: Uint8Array): string {
  return createHash("sha256").update(audio).digest("hex").slice(0, 16);
}

function runFfmpegToFile(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new MusicError(`ffmpeg timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: Error) => { clearTimeout(timer); reject(new MusicError(`ffmpeg failed to start: ${error.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new MusicError(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)); });
  });
}

/**
 * Masters the music bed for delivery: ducks under the narration mix
 * (sidechain) when a narration file is given, then loudness-normalizes to
 * the target LUFS (default −14, streaming standard).
 */
export async function masterMusicBed(
  musicPath: string,
  narrationPath: string | null,
  outputPath: string,
  options: { targetLufs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const target = options.targetLufs ?? -14;
  const timeout = options.timeoutMs ?? 120_000;
  if (narrationPath) {
    await runFfmpegToFile([
      "-i", musicPath, "-i", narrationPath,
      "-filter_complex",
      `[0:a]sidechaincompress=threshold=0.03:ratio=8:attack=80:release=600[ducked];[ducked]loudnorm=I=${target}:TP=-1.5:LRA=11[out]`,
      "-map", "[out]", "-ar", "44100", outputPath,
    ], timeout);
  } else {
    await runFfmpegToFile([
      "-i", musicPath,
      "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11`,
      "-ar", "44100", outputPath,
    ], timeout);
  }
  return outputPath;
}

export interface BeatGrid {
  bpm: number;
  beatsMs: number[];
}

/**
 * Energy-based onset detection: decodes to mono PCM via ffmpeg, builds a
 * 10 ms RMS envelope, picks local peaks above an adaptive threshold, and
 * derives BPM from the median inter-onset interval (folded into 70–180).
 * Grid quality is beat-tracking heuristic, not librosa-grade — verify cut
 * points against the returned grid before committing a sync cut.
 */
export async function detectBeats(audioPath: string, options: { timeoutMs?: number } = {}): Promise<BeatGrid> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-loglevel", "error", "-i", audioPath,
      "-ac", "1", "-ar", "22050", "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new MusicError("beat detection timed out")); }, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: Error) => { clearTimeout(timer); reject(new MusicError(`ffmpeg failed to start: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new MusicError(`ffmpeg exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
  const hop = 220; // 10 ms at 22050 Hz
  const envelopeValues: number[] = [];
  for (let offset = 0; offset + hop <= raw.length / 2; offset += hop) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const sample = raw.readInt16LE((offset + i) * 2) / 32768;
      sum += sample * sample;
    }
    envelopeValues.push(Math.sqrt(sum / hop));
  }
  if (envelopeValues.length < 50) return { bpm: 0, beatsMs: [] };
  const mean = envelopeValues.reduce((a, b) => a + b, 0) / envelopeValues.length;
  const std = Math.sqrt(envelopeValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / envelopeValues.length);
  const threshold = mean + std * 1.1;
  const minGap = 25; // envelope frames → 250 ms
  const peaks: number[] = [];
  for (let i = 1; i < envelopeValues.length - 1; i++) {
    if (envelopeValues[i]! > threshold && envelopeValues[i]! >= envelopeValues[i - 1]! && envelopeValues[i]! > envelopeValues[i + 1]!) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1]! >= minGap) peaks.push(i);
    }
  }
  if (peaks.length < 4) return { bpm: 0, beatsMs: peaks.map((frame) => frame * 10) };
  const intervals = peaks.slice(1).map((frame, index) => frame - peaks[index]!).sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)]! * 10; // ms
  let bpm = median > 0 ? 60000 / median : 0;
  while (bpm > 180) bpm /= 2;
  while (bpm > 0 && bpm < 70) bpm *= 2;
  return { bpm: Math.round(bpm * 10) / 10, beatsMs: peaks.map((frame) => frame * 10) };
}
