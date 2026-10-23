/**
 * Frame rate handling with exact NTSC rationals.
 *
 * `fps: 29.97` in a project file means 30000/1001, not 2997/100. Storing the
 * decimal everywhere accumulates drift over long timelines, so every frame
 * conversion goes through this module and ffmpeg receives the rational text.
 */

export interface FrameRate {
  /** Decimal value used for continuous maths (seeking, camera easing). */
  value: number;
  /** Exact ffmpeg expression, e.g. "30000/1001" or "30". */
  text: string;
  numerator: number;
  denominator: number;
}

const NTSC: FrameRate[] = [
  { value: 24000 / 1001, text: "24000/1001", numerator: 24000, denominator: 1001 },
  { value: 30000 / 1001, text: "30000/1001", numerator: 30000, denominator: 1001 },
  { value: 60000 / 1001, text: "60000/1001", numerator: 60000, denominator: 1001 },
  { value: 120000 / 1001, text: "120000/1001", numerator: 120000, denominator: 1001 },
];

/** Nearest exact rate for a decimal fps; throws on impossible or absurd values. */
export function frameRateOf(fps: number): FrameRate {
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error("fps must be a finite number in 1..120");
  for (const candidate of NTSC) if (Math.abs(fps - candidate.value) < 0.002) return candidate;
  const rounded = Math.round(fps * 1000) / 1000;
  if (Math.abs(fps - rounded) > 1e-6) throw new Error("fps supports at most three decimals");
  const scaled = Math.round(rounded * 1000);
  return { value: rounded, text: String(rounded), numerator: scaled, denominator: 1000 };
}

/** Frame index whose presentation time is closest to `ms` (round half up). */
export function framesForMs(ms: number, rate: FrameRate): number {
  if (!Number.isFinite(ms)) throw new Error("ms must be finite");
  return Math.round((ms * rate.numerator) / (1000 * rate.denominator));
}

/** Presentation time in milliseconds for a frame index. */
export function msForFrame(frame: number, rate: FrameRate): number {
  if (!Number.isInteger(frame) || frame < 0) throw new Error("frame must be a non-negative integer");
  return (frame * rate.denominator * 1000) / rate.numerator;
}

export function resolveFrameRate(fps?: number): FrameRate {
  return frameRateOf(fps ?? 30);
}

export interface RetimeOptions {
  /** Playback speed of the source clip; 1 = realtime. */
  speed?: number;
  trimStartSec?: number;
}

/** Source-media time for a composition frame, honouring trim and speed. */
export function sourceTimeForFrame(frame: number, fps: number, options: RetimeOptions = {}): number {
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("speed must be within 0.25..4");
  const rate = frameRateOf(fps);
  return (options.trimStartSec ?? 0) + (frame / rate.value) * speed;
}

export interface VideoSourceWindow {
  /** First source frame shown in the scene. */
  startFrom: number;
  /** Last source frame (exclusive); undefined means "play to the end". */
  endAt?: number;
  playbackRate: number;
}

/** Maps a composition window onto source frames for Video/OffthreadVideo. */
export function videoSourceWindow(scene: { trimStartSec?: number; trimEndSec?: number; speed?: number }, fps: number, durationFrames: number): VideoSourceWindow {
  const rate = frameRateOf(fps);
  const speed = scene.speed ?? 1;
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("speed must be within 0.25..4");
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) throw new Error("durationFrames must be a positive integer");
  if (scene.trimEndSec !== undefined && scene.trimEndSec <= (scene.trimStartSec ?? 0)) throw new Error("Video trim start must precede trim end");
  const startFrom = Math.max(0, Math.round((scene.trimStartSec ?? 0) * rate.value));
  const consumed = Math.max(1, Math.round(durationFrames * speed));
  const endAt = scene.trimEndSec !== undefined ? Math.round(scene.trimEndSec * rate.value) : startFrom + consumed;
  return { startFrom, endAt: Math.max(startFrom + 1, endAt), playbackRate: speed };
}