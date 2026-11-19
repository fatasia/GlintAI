import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { analyzeReference } from "./reference-video";
// @ts-expect-error The existing local OCR adapter is an untyped JavaScript module.
import { runReferenceOcr } from "../../web/server/reference-ocr.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestFile = path.join(root, "apps/studio/scripts/reference-eval-fixtures.json");
const toleranceMs = 100;

export function matchCuts(expected: number[], actual: number[], tolerance: number) {
  if (![...expected, ...actual, tolerance].every(Number.isFinite) || tolerance < 0 ||
      expected.some((v, i) => v < 0 || (i > 0 && v <= expected[i - 1]!)) ||
      actual.some((v, i) => v < 0 || (i > 0 && v <= actual[i - 1]!))) throw new Error("Cut times must be strictly increasing nonnegative numbers; tolerance must be nonnegative");
  type Match = { pairs: [number, number][]; error: number };
  const rows: Match[][] = Array.from({ length: expected.length + 1 }, () => Array.from({ length: actual.length + 1 }, () => ({ pairs: [], error: 0 })));
  const better = (a: Match, b: Match) => a.pairs.length !== b.pairs.length ? (a.pairs.length > b.pairs.length ? a : b) : (a.error <= b.error ? a : b);
  for (let i = 1; i <= expected.length; i++) for (let j = 1; j <= actual.length; j++) {
    let best = better(rows[i - 1]![j]!, rows[i]![j - 1]!);
    const diff = Math.abs(expected[i - 1]! - actual[j - 1]!);
    if (diff <= tolerance) {
      const previous = rows[i - 1]![j - 1]!;
      best = better(best, { pairs: [...previous.pairs, [expected[i - 1]!, actual[j - 1]!]], error: previous.error + diff });
    }
    rows[i]![j] = best;
  }
  const matched = rows[expected.length]![actual.length]!;
  return { pairs: matched.pairs, tp: matched.pairs.length, fp: actual.length - matched.pairs.length, fn: expected.length - matched.pairs.length, absoluteErrorMs: matched.error };
}

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
export function targetDistance(target: string, lines: string[]): { distance: number; length: number; exact: boolean } {
  const truth = Array.from(normalize(target));
  if (!truth.length) throw new Error("OCR target must contain a letter or number");
  // Best substring across individual OCR lines: other unlabelled text is deliberately ignored.
  let best = truth.length;
  for (const line of lines) {
    const chars = Array.from(normalize(line));
    let previous = Array.from({ length: chars.length + 1 }, () => 0);
    for (let i = 1; i <= truth.length; i++) {
      const next = [i];
      for (let j = 1; j <= chars.length; j++) next[j] = Math.min(next[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (truth[i - 1] === chars[j - 1] ? 0 : 1));
      previous = next;
    }
    best = Math.min(best, ...previous);
  }
  return { distance: best, length: truth.length, exact: best === 0 };
}

export function scoreOcrFrame(frame: { atMs: number; targets: string[]; noText?: true }, lines: string[]) {
  return { atMs: frame.atMs, recognized: lines, ...(frame.noText ? { noText: true, falsePositive: lines.length > 0 } : {}), targets: frame.targets.map(target => ({ text: target, ...targetDistance(target, lines) })) };
}

export function summarizeOcrFrames(frames: ReturnType<typeof scoreOcrFrame>[]) {
  const noTextFrames = frames.filter(frame => frame.noText);
  const falsePositiveFrames = noTextFrames.filter(frame => frame.falsePositive).length;
  return { noTextFrames: noTextFrames.length, falsePositiveFrames,
    noTextFrameFalsePositiveRate: noTextFrames.length ? falsePositiveFrames / noTextFrames.length : null };
}

export function validateManifest(manifest: any) {
  if (manifest?.version !== 1 || manifest.datasetKind !== "synthetic-rendered" || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("Expected a nonempty version-1 synthetic-rendered dataset; real footage needs separate provenance and annotations");
  const ids = new Set<string>();
  for (const item of manifest.cases) {
    if (!item || typeof item.id !== "string" || !/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id)) throw new Error("Fixture IDs must be unique lowercase identifiers");
    ids.add(item.id);
    if (typeof item.path !== "string" || path.isAbsolute(item.path) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Invalid path or SHA-256: ${item.id}`);
    if (!Array.isArray(item.cutsMs) || !Array.isArray(item.frames) || !item.frames.length || item.frames.length > 12) throw new Error(`Expected cuts and 1–12 annotated frames: ${item.id}`);
    matchCuts(item.cutsMs, [], toleranceMs);
    for (const frame of item.frames) {
      if (!Number.isInteger(frame?.atMs) || frame.atMs < 0 || !Array.isArray(frame.targets) ||
          (frame.noText !== undefined && frame.noText !== true) ||
          (frame.noText === true ? frame.targets.length !== 0 : frame.targets.length === 0) ||
          frame.targets.some((target: unknown) => typeof target !== "string" || !normalize(target))) throw new Error(`Invalid annotated frame: ${item.id}`);
    }
  }
}

export function evaluationThreshold(args: string[]): number | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 1 || !/^--threshold=(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(args[0]!)) {
    throw new Error("Usage: reference-eval [--threshold=0..1]");
  }
  return Number(args[0]!.slice("--threshold=".length));
}

export function evaluationOptions(args: string[]): { threshold?: number; cutsOnly: boolean } {
  const cutsOnly = args.includes("--cuts-only");
  const thresholdArgs = args.filter(arg => arg !== "--cuts-only");
  if (args.filter(arg => arg === "--cuts-only").length > 1) throw new Error("Usage: reference-eval [--threshold=0..1] [--cuts-only]");
  return { threshold: evaluationThreshold(thresholdArgs), cutsOnly };
}

export async function evaluate(options: { threshold?: number; cutsOnly?: boolean } = {}) {
  if (options.threshold !== undefined && (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1)) throw new Error("threshold must be between 0 and 1");
  const manifestBytes = await fs.readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(manifest);
  const python = process.env.GLINT_REFERENCE_OCR_PYTHON;
  if (!options.cutsOnly && (!python || !path.isAbsolute(python))) throw new Error("Set GLINT_REFERENCE_OCR_PYTHON to the trusted absolute local OCR Python path; no model is downloaded.");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "glint-ref-eval-"));
  try {
    const results = [];
    for (const item of manifest.cases) {
      const source = await fs.realpath(path.resolve(root, item.path));
      const relative = path.relative(await fs.realpath(root), source);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Fixture path must stay in the repository");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source)) hash.update(chunk);
      if (hash.digest("hex") !== item.sha256) throw new Error(`Fixture hash mismatch: ${item.id}`);
      const report = await analyzeReference({ videoPath: source, outDir: path.join(temp, item.id), maxShots: 30, threshold: options.threshold });
      if (report.source.sha256 !== item.sha256) throw new Error(`Fixture hash mismatch: ${item.id}`);
      if (item.cutsMs.some((cut: number) => cut <= 0 || cut >= report.source.durationMs) || item.frames.some((frame: { atMs: number }) => frame.atMs >= report.source.durationMs)) throw new Error(`Annotation outside video duration: ${item.id}`);
      const boundaries = matchCuts(item.cutsMs, report.shots.slice(1).map(shot => shot.startMs), toleranceMs);
      let frames: ReturnType<typeof scoreOcrFrame>[] = [];
      if (!options.cutsOnly) {
        // Fixed annotated timestamps isolate OCR accuracy from errors in automatic shot segmentation.
        const fixedReport = { ...report, shots: item.frames.map((frame: { atMs: number }, i: number) => ({ id: `shot-${String(i + 1).padStart(3, "0")}`, startMs: frame.atMs, endMs: frame.atMs })) };
        const ocr = await runReferenceOcr({ source, report: fixedReport, signal: AbortSignal.timeout(120_000), python });
        if (ocr.status !== "complete") throw new Error(`Local OCR ${ocr.status} for ${item.id}; check Python and dependencies`);
        frames = item.frames.map((frame: { atMs: number; targets: string[]; noText?: true }, i: number) => {
          const lines: string[] = ocr.samples[i].lines.map((line: { text: string }) => line.text);
          return scoreOcrFrame(frame, lines);
        });
      }
      results.push({ id: item.id, sourceSha256: report.source.sha256, durationMs: report.source.durationMs, inferredCutsMs: report.shots.slice(1).map(shot => shot.startMs), boundaries, limits: report.limits, frames });
    }
    const negative = summarizeOcrFrames(results.flatMap(item => item.frames));
    const counts = results.reduce((sum, item) => {
      sum.tp += item.boundaries.tp; sum.fp += item.boundaries.fp; sum.fn += item.boundaries.fn;
      for (const frame of item.frames) {
        for (const target of frame.targets) {
          sum.targets++; sum.exactTargets += Number(target.exact); sum.editErrors += target.distance; sum.targetCharacters += target.length;
        }
      }
      return sum;
    }, { tp: 0, fp: 0, fn: 0, targets: 0, exactTargets: 0, editErrors: 0, targetCharacters: 0 });
    return { version: 1, datasetKind: manifest.datasetKind, ocrEvaluated: !options.cutsOnly, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), toleranceMs, counts: { ...counts, noTextFrames: negative.noTextFrames, falsePositiveFrames: negative.falsePositiveFrames },
      metrics: { cutPrecision: counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null,
        cutRecall: counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null,
        targetExactRate: counts.targets ? counts.exactTargets / counts.targets : null,
        targetSubstringEditRate: counts.targetCharacters ? counts.editErrors / counts.targetCharacters : null,
        noTextFrameFalsePositiveRate: negative.noTextFrameFalsePositiveRate },
      note: "Synthetic Glint renders only, not real footage or calibrated confidence. OCR evaluates annotated targets in fixed frames; unlabelled text on positive frames is ignored. Only explicitly fully annotated no-text frames measure frame-level false positives. Target substring edit error is not standard full-frame CER. Scores are not probabilities.", results };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => evaluate(evaluationOptions(process.argv.slice(2)))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
