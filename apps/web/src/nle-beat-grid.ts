/** Manual, fixed-tempo timing guide. It does not analyze or claim to match audio. */
export interface ManualBeatGrid { bpm: number; offsetMs: number; subdivisions: 1 | 2 | 4 }

/** Explicitly convert a segment-relative proposal into an editable timeline grid. */
export function calibrationToManualGrid(candidate: { bpm: number; offsetMs: number }, clipStartMs: number, subdivisions: 1 | 2 | 4 = 1): ManualBeatGrid | null {
  const offsetMs = clipStartMs + candidate.offsetMs;
  if (!Number.isFinite(clipStartMs) || clipStartMs < 0 || !Number.isFinite(candidate.offsetMs) || candidate.offsetMs < 0 || !Number.isFinite(candidate.bpm) || candidate.bpm < 30 || candidate.bpm > 300 || offsetMs > 21_600_000 || ![1, 2, 4].includes(subdivisions)) return null;
  return { bpm: candidate.bpm, offsetMs, subdivisions };
}

/** Nearest detected transient on either side, without quantising an irregular rhythm. */
export function onsetSnapCandidates(valueMs: number, onsetsMs: readonly number[]): number[] {
  if (!Number.isFinite(valueMs) || !onsetsMs.length) return [];
  let lo = 0, hi = onsetsMs.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (onsetsMs[mid]! < valueMs) lo = mid + 1; else hi = mid; }
  return [onsetsMs[lo - 1], onsetsMs[lo]].filter((time): time is number => time !== undefined);
}

/** Calculate only neighbours of the dragged time; never allocate a whole long-film grid. */
export function beatSnapCandidates(valueMs: number, grid: ManualBeatGrid): number[] {
  if (!Number.isFinite(valueMs) || valueMs < 0 || !Number.isFinite(grid.bpm) || grid.bpm < 30 || grid.bpm > 300 || !Number.isFinite(grid.offsetMs) || grid.offsetMs < 0 || grid.offsetMs > 21_600_000 || ![1, 2, 4].includes(grid.subdivisions)) return [];
  const period = 60_000 / grid.bpm / grid.subdivisions;
  const position = (valueMs - grid.offsetMs) / period;
  const first = Math.max(0, Math.floor(position)), last = Math.max(0, Math.ceil(position));
  return [...new Set([first, last].map(index => Math.round(grid.offsetMs + index * period)))].filter(time => time <= 21_600_000);
}
