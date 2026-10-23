import { frameRateOf, type FrameEntry } from "@glintai/scenescript";

export interface StitchPlan { filter: string; output: string; totalFrames: number; overlaps: number[] }

/** All join offsets use already-rounded frame boundaries, not millisecond estimates. */
export function buildStitchPlan(entries: Pick<FrameEntry, "from" | "duration">[], fps: number): StitchPlan {
  if (!entries.length || !Number.isFinite(fps) || fps < 1) throw new Error("Stitching requires scenes and a positive fps");
  const rate = frameRateOf(fps);
  const filters = entries.map((_, i) => `[${i}:v]fps=${rate.text},settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
  let previous = "v0", totalFrames = entries[0]!.duration;
  const overlaps = [0];
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    const overlap = Math.max(0, totalFrames - entry.from);
    if (overlap >= entry.duration || overlap >= entries[i - 1]!.duration) throw new Error("Transition consumes an entire adjacent scene");
    const output = `join${i}`;
    if (overlap > 0) filters.push(`[${previous}][v${i}]xfade=transition=fade:duration=${overlap / rate.value}:offset=${entry.from / rate.value}[${output}]`);
    else filters.push(`[${previous}][v${i}]concat=n=2:v=1:a=0[${output}]`);
    totalFrames = entry.from + entry.duration;
    overlaps.push(overlap); previous = output;
  }
  return { filter: filters.join(";"), output: previous, totalFrames, overlaps };
}
