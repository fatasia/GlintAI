export type TemporalDecision = "cut" | "transient" | "uncertain";
export type TemporalReview = { decision: TemporalDecision; reason: string };

const FRAME_BYTES = 64 * 36;
const RETURN_RATIO = 0.45;
const POST_CHANGE_RATIO = 0.55;
const HISTOGRAM_BINS = 16;
const SIMILAR_DISTRIBUTION = 0.10;
const TRANSLATION_MATCH_RATIO = 0.35;
const LOW_CONTRAST_RATIO = 3;

type Frames = { before: Buffer[]; after: Buffer[] };

function distance(a: Buffer, b: Buffer): number {
  let total = 0;
  for (let i = 0; i < FRAME_BYTES; i++) total += Math.abs(a[i]! - b[i]!);
  return total / (FRAME_BYTES * 255);
}

function distributionDifference(a: Buffer, b: Buffer): number {
  const counts = new Int32Array(HISTOGRAM_BINS);
  for (let i = 0; i < FRAME_BYTES; i++) {
    counts[a[i]! >> 4]!++;
    counts[b[i]! >> 4]!--;
  }
  return counts.reduce((sum, n) => sum + Math.abs(n), 0) / (FRAME_BYTES * 2);
}

function plausibleHorizontalTranslation(a: Buffer, b: Buffer, change: number): boolean {
  // Compare only overlapping pixels; large shifts with too little overlap are not evidence.
  for (let shift = -48; shift <= 48; shift++) {
    if (Math.abs(shift) < 2) continue;
    let total = 0, count = 0;
    for (let y = 0; y < 36; y++) for (let x = Math.max(0, shift); x < Math.min(64, 64 + shift); x++) {
      total += Math.abs(a[y * 64 + x]! - b[y * 64 + x - shift]!);
      count++;
    }
    if (total / (count * 255) < change * TRANSLATION_MATCH_RATIO) return true;
  }
  return false;
}

/** Heuristics describe evidence, not a calibrated probability or semantic scene identity. */
export function reviewTemporalFrames({ before, after }: Frames, score: number, baseline: number): TemporalReview {
  if (!before.length || after.length < 2 || [...before, ...after].some(frame => frame.length !== FRAME_BYTES)) {
    return { decision: "uncertain", reason: "insufficient-temporal-frames" };
  }
  const previous = before.at(-1)!, current = after[0]!;
  const change = distance(previous, current);
  if (change === 0) return { decision: "uncertain", reason: "no-measurable-change" };
  // Short returns can be flashes or genuine short shots; keep them reviewable.
  if (after.slice(1).some(frame => distance(previous, frame) < change * RETURN_RATIO) ||
      before.slice(0, -1).some(frame => distance(frame, current) < change * RETURN_RATIO && distance(frame, previous) > change * (1 - RETURN_RATIO))) {
    return { decision: "transient", reason: "short-return" };
  }
  const postChanges = after.slice(1).map((frame, i) => distance(after[i]!, frame));
  if (postChanges[0]! >= change * POST_CHANGE_RATIO) {
    // A short sequence of comparable changes may be a dissolve, fast motion, or cuts.
    return { decision: "uncertain", reason: "continuing-change" };
  }
  if (distributionDifference(previous, current) < SIMILAR_DISTRIBUTION && plausibleHorizontalTranslation(previous, current, change)) {
    return { decision: "uncertain", reason: "possible-spatial-displacement" };
  }
  if (score < baseline * LOW_CONTRAST_RATIO) return { decision: "uncertain", reason: "weak-local-contrast" };
  return { decision: "cut", reason: "persistent-discontinuity" };
}
