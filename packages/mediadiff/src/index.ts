/**
 * Frame-level media diff.
 *
 * The renderer caches per scene; this package answers what that cache cannot:
 * did the delivered pixels change outside the scenes the plan said would change?
 *
 * Each frame becomes a 16×16 luminance fingerprint (256 samples). We compare
 * per-cell luminance, not gradients: a large flat object (a product card, a
 * price block) barely changes a difference hash but clearly changes luminance.
 */

const GRID = 16;

/** 16×16 luminance fingerprint as 512 hex characters. */
export function frameFingerprint(gray: Uint8Array, width: number, height: number, grid = GRID): string {
  if (!(gray instanceof Uint8Array)) throw new Error("Fingerprint needs a Uint8Array of gray pixels");
  if (!Number.isInteger(grid) || grid < 4 || grid > 32) throw new Error("Fingerprint grid must be 4..32");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < grid || height < grid) throw new Error(`Fingerprint needs a gray frame of at least ${grid}×${grid}`);
  if (gray.length < width * height) throw new Error("Fingerprint input is shorter than width × height");
  const sampleX = (x: number) => Math.round((x * (width - 1)) / Math.max(1, grid - 1));
  const sampleY = (y: number) => Math.round((y * (height - 1)) / Math.max(1, grid - 1));
  let hex = "";
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) hex += gray[sampleY(y) * width + sampleX(x)]!.toString(16).padStart(2, "0");
  return hex;
}

export interface FingerprintDistance {
  /** Cells whose luminance differs by more than the per-cell threshold. */
  changedCells: number;
  meanAbs: number;
  maxAbs: number;
}

export function fingerprintDistance(a: string, b: string, cellThreshold = 12): FingerprintDistance {
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b) || a.length !== b.length || a.length % 2 !== 0) throw new Error("Fingerprints must be equal-length even hex strings");
  let changedCells = 0, sum = 0, maxAbs = 0;
  for (let i = 0; i < a.length; i += 2) {
    const delta = Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
    sum += delta;
    maxAbs = Math.max(maxAbs, delta);
    if (delta > cellThreshold) changedCells++;
  }
  const cells = a.length / 2;
  return { changedCells, meanAbs: sum / cells, maxAbs };
}

export interface FrameDiffOptions {
  /** Luminance delta (0..255) before a cell counts as changed. Default 12. */
  cellThreshold?: number;
  /** Fraction of changed cells before a frame counts as changed. Default 0.02. */
  changedCells?: number;
  /** Allowed ratio of changed frames before the diff fails. Default 0.02. */
  maxChangedRatio?: number;
}

export interface FrameDiff {
  total: number;
  changed: number[];
  ranges: [number, number][];
  ratio: number;
  maxDistance: number;
  meanDistance: number;
  lengthMismatch: boolean;
  pass: boolean;
}

/** Merges sorted frame indices into inclusive ranges. */
export function toRanges(indices: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && index === last[1] + 1) last[1] = index;
    else ranges.push([index, index]);
  }
  return ranges;
}

export function diffFingerprints(before: readonly string[], after: readonly string[], options: FrameDiffOptions = {}): FrameDiff {
  const sample = before[0] ?? after[0];
  if (!sample) throw new Error("Frame diff needs at least one sampled frame");
  const cellThreshold = options.cellThreshold ?? 12;
  const changedCellRatio = options.changedCells ?? 0.02;
  const maxChangedRatio = options.maxChangedRatio ?? 0.02;
  if (!Number.isFinite(cellThreshold) || cellThreshold < 0 || cellThreshold > 255) throw new Error("cellThreshold must be 0..255");
  if (!Number.isFinite(changedCellRatio) || changedCellRatio < 0 || changedCellRatio > 1) throw new Error("changedCells must be 0..1");
  if (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) throw new Error("maxChangedRatio must be 0..1");
  const cells = sample.length / 2;
  const total = Math.max(before.length, after.length);
  const changed: number[] = [];
  let maxDistance = 0, sumDistance = 0;
  for (let index = 0; index < total; index++) {
    const a = before[index], b = after[index];
    if (a === undefined || b === undefined) { changed.push(index); maxDistance = 255; sumDistance += 255; continue; }
    const distance = fingerprintDistance(a, b, cellThreshold);
    maxDistance = Math.max(maxDistance, distance.meanAbs);
    sumDistance += distance.meanAbs;
    if (distance.changedCells / cells > changedCellRatio) changed.push(index);
  }
  const ratio = total === 0 ? 0 : changed.length / total;
  return {
    total,
    changed,
    ranges: toRanges(changed),
    ratio,
    maxDistance,
    meanDistance: total === 0 ? 0 : sumDistance / total,
    lengthMismatch: before.length !== after.length,
    pass: ratio <= maxChangedRatio,
  };
}

/** Human-readable location of a frame index at a given sampling rate. */
export function frameTimecode(frame: number, fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be positive");
  const totalMs = Math.round((frame / fps) * 1000), ms = totalMs % 1000, seconds = Math.floor(totalMs / 1000);
  const hh = Math.floor(seconds / 3600), mm = Math.floor((seconds % 3600) / 60), ss = seconds % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
