import type { NleProject } from "@glintai/scenescript";
import { motionOptions, checkMotionBudget } from "../../studio/scripts/nle-motion";

/** Timeline span the renderer covers: last clip end, floored at 100 ms. */
export function nleRenderDurationMs(project: NleProject): number {
  return Math.max(
    ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.startMs + clip.durationMs)),
    100,
  );
}

export function nleRenderOptions(project: NleProject, samples: unknown = 1, angle: unknown = 180) {
  if (typeof samples !== "number" || typeof angle !== "number")
    throw new Error("Motion options must be numbers");
  const motion = motionOptions(samples, angle);
  const frames = Math.max(1, Math.round((nleRenderDurationMs(project) / 1000) * project.fps));
  checkMotionBudget(motion, project.width, project.height, frames);
  return { motionSamples: motion.samples, shutterAngle: motion.shutterAngle };
}

export function nleMotionArgs(samples: number = 1, angle: number = 180): string[] {
  const motion = motionOptions(samples, angle);
  return motion.samples === 1
    ? []
    : [`--motion-samples=${motion.samples}`, `--shutter-angle=${motion.shutterAngle}`];
}
