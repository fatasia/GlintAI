import type { NleProject } from "@glintai/scenescript";
export type MotionOptions = { samples: 1 | 2 | 4 | 8; shutterAngle: number };
export function motionOptions(samples: number = 1, shutterAngle: number = 180): MotionOptions {
  if (![1, 2, 4, 8].includes(samples)) throw new Error("motion-samples must be 1, 2, 4 or 8");
  if (!Number.isFinite(shutterAngle) || shutterAngle <= 0 || shutterAngle > 360) throw new Error("shutter-angle must be greater than 0 and at most 360");
  return { samples: samples as MotionOptions["samples"], shutterAngle };
}
export function checkMotionBudget(options: MotionOptions, width: number, height: number, frames: number): void {
  if (options.samples === 1) return;
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0)
    || Math.max(width, height) > 1280 || Math.min(width, height) > 720 || width * height > 921600
    || frames * options.samples > 2400 || frames * options.samples * width * height > 1105920000)
    throw new Error("Motion blur limit: 720p, 2400 sample-frames and 1105920000 sample-pixels");
}
/** Clip lifecycle boundaries include overlays: no averaged frame borrows a prior shot/layer. */
export function motionCuts(project: NleProject): number[] {
  return [...new Set([0, ...project.tracks.flatMap(track => track.clips.filter(clip => clip.kind !== "audio").flatMap(clip => [clip.startMs, clip.startMs + clip.durationMs]))])].sort((a, b) => a - b);
}
/** Trailing shutter, fixed midpoint quadrature, held edge values at starts/cuts. */
export function motionTimes(frame: number, fps: number, cuts: readonly number[], options: MotionOptions): number[] {
  if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("Invalid motion sample frame");
  const time = frame * 1000 / fps;
  if (options.samples === 1) return [time];
  let left = 0;
  for (const cut of cuts) { if (cut > time) break; left = cut; }
  const exposure = 1000 / fps * options.shutterAngle / 360;
  return Array.from({ length: options.samples }, (_, index) => Math.max(left, time - exposure + (index + 0.5) * exposure / options.samples));
}

export function motionCliOptions(args: string[]) {
  const read = (name: string, fallback: number) => {
    const values = args.filter(value => value === `--${name}` || value.startsWith(`--${name}=`));
    if (values.length > 1 || values.some(value => !new RegExp(`^--${name}=\\d+(?:\\.\\d+)?$`).test(value))) throw new Error(`Invalid --${name}=number`);
    return values.length ? Number(values[0]!.slice(name.length + 3)) : fallback;
  };
  return motionOptions(read("motion-samples", 1), read("shutter-angle", 180));
}
