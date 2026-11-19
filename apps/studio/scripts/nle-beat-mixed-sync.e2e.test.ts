import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseNleProject, nleSnap } from "@glintai/scenescript";
import { beatSnapCandidates, calibrationToManualGrid } from "../../web/src/nle-beat-grid";
import { renderNle } from "./nle-render";
// @ts-expect-error JavaScript module used by the editor API.
import { analyzeNleAudioBeats } from "../../web/server/nle-beat-analysis.mjs";

// MOTION-08 annotated fixture: self-composed and synthesized test music, not a
// recording of real musicians. The score below is the single source of truth for
// both sample placement and annotations; the calibration pipeline only ever sees
// the rendered audio, so scoring candidates against the score is not circular.
const BPM = 120, BEAT_MS = 60_000 / BPM, GRID_OFFSET_MS = 200, BEAT_COUNT = 8;
const SNARE_DRAG_MS = 14; // Humanized drag: backbeat snares sit behind the grid on purpose.
const HEAD_CAP_MS = 200, TAIL_CAP_MS = 3_950, ARRANGEMENT_END_MS = 3_800; // Silence caps.
const CLIP_START_MS = 500, CLIP_DURATION_MS = 3_500; // Analysis window [500, 4000) of the file.
const HIT_TOLERANCE_MS = 40; // 8% of a beat; above the 10 ms measurement bin and the drag.
const CHORD_A = [220, 277.18, 329.63], CHORD_D = [293.66, 369.99, 440], PAD_AMP = 0.028;
const ARP_NOTES = [440, 523.25, 659.25, 587.33];

type Instrument = "kick" | "snare" | "ping";
interface ScoreHit { timeMs: number; kind: Instrument }

/** Annotated score: every percussion onset the synthesis plays, drag included. */
function score(): ScoreHit[] {
  const hits: ScoreHit[] = [];
  for (let beat = 0; beat < BEAT_COUNT; beat++) {
    const timeMs = GRID_OFFSET_MS + beat * BEAT_MS;
    hits.push({ timeMs, kind: "ping" }); // 3 kHz beacon on every beat keeps onsets measurable.
    if (beat % 2 === 0) hits.push({ timeMs, kind: "kick" });
    else hits.push({ timeMs: timeMs + SNARE_DRAG_MS, kind: "snare" });
  }
  return hits;
}

const rounded = (value: number) => Math.round(value * 10) / 10;

/** Score one proposed grid against the arrangement: median/max distance from each
 *  annotated onset inside the analysis window to the nearest candidate grid line,
 *  plus the share of onsets within HIT_TOLERANCE_MS. */
function annotationMetrics(hits: ScoreHit[], candidate: { bpm: number; offsetMs: number }) {
  const period = 60_000 / candidate.bpm, windowEnd = CLIP_START_MS + CLIP_DURATION_MS;
  const lines: number[] = [];
  for (let index = 0; CLIP_START_MS + candidate.offsetMs + index * period < windowEnd; index++) {
    const line = CLIP_START_MS + candidate.offsetMs + index * period;
    if (line >= CLIP_START_MS) lines.push(line);
  }
  const onsets = [...new Set(hits.map(hit => hit.timeMs))].filter(time => time >= CLIP_START_MS && time < windowEnd).sort((a, b) => a - b);
  expect(lines.length, `candidate ${JSON.stringify(candidate)} has grid lines in the window`).toBeGreaterThan(0);
  expect(onsets.length, "the score has annotated onsets inside the analysis window").toBeGreaterThan(0);
  const errors = onsets.map(onset => Math.min(...lines.map(line => Math.abs(line - onset)))).sort((a, b) => a - b);
  const median = errors.length % 2 ? errors[(errors.length - 1) / 2]! : (errors[errors.length / 2 - 1]! + errors[errors.length / 2]!) / 2;
  const hitCount = errors.filter(error => error <= HIT_TOLERANCE_MS).length;
  return { onsets: onsets.length, gridLines: lines.length, medianErrorMs: rounded(median), maxErrorMs: rounded(errors.at(-1)!), hitCount, hitRate: Math.round(hitCount / onsets.length * 1000) / 1000 };
}

function mixedMusic(hits: ScoreHit[]): Buffer {
  const rate = 44_100, frames = rate * 5, pcm = Buffer.alloc(44 + frames * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(frames * 2, 40);
  // Percussion and bass render sample-accurately from the annotated onsets. Every
  // instrument is a pure sine, so nothing but the ping has energy in the 2.75–3.25 kHz
  // measurement band and the bandpass onset probe cannot confuse the layers.
  const events = hits.map(hit => ({ start: Math.round(hit.timeMs / 1000 * rate), kind: hit.kind }));
  const bass = hits.filter(hit => hit.kind === "kick").map(hit => Math.round(hit.timeMs / 1000 * rate));
  for (let i = 0; i < frames; i++) {
    const t = i / rate, ms = t * 1000;
    let value = 0;
    if (ms >= HEAD_CAP_MS && ms < TAIL_CAP_MS) {
      for (const event of events) {
        const u = (i - event.start) / rate;
        if (u < 0) continue;
        if (event.kind === "ping" && u < 0.045) value += 0.40 * Math.exp(-u * 45) * Math.sin(2 * Math.PI * 3000 * u);
        if (event.kind === "kick" && u < 0.25) value += 0.34 * Math.exp(-u * 9) * Math.sin(2 * Math.PI * (95 * u - 60 * u * u));
        if (event.kind === "snare" && u < 0.18) value += 0.30 * Math.exp(-u * 22) * (0.6 * Math.sin(2 * Math.PI * 185 * u) + 0.4 * Math.sin(2 * Math.PI * 330 * u) + 0.3 * Math.sin(2 * Math.PI * 1200 * u));
      }
      for (const start of bass) {
        const u = (i - start) / rate;
        if (u >= 0 && u < 0.4) value += 0.10 * Math.exp(-u * 7) * Math.sin(2 * Math.PI * (82 * u - 20 * u * u));
      }
      const pad = (notes: number[], from: number, to: number) => {
        if (t < from || t >= to) return 0;
        const edge = Math.min((t - from) / 0.12, (to - t) / 0.12, 1);
        return notes.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0) * PAD_AMP * Math.max(0, edge);
      };
      value += pad(CHORD_A, 0.2, 2.2) + pad(CHORD_D, 2.2, ARRANGEMENT_END_MS / 1000);
      if (t >= 0.2 && t < ARRANGEMENT_END_MS / 1000) {
        const note = ARP_NOTES[Math.floor((t - 0.2) / 0.25) % ARP_NOTES.length]!;
        value += 0.06 * Math.sin(2 * Math.PI * note * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t));
      }
    }
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  return pcm;
}

// Independent fixture: different tempo/phase and syncopation, noise-based percussion,
// bass and chords. The beat annotations are score metadata, never mixed as beacons.
function independentMusic(): { wav: Buffer; annotations: ScoreHit[] } {
  const rate = 44_100, frames = rate * 5, wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
  const beatMs = 60_000 / 110, annotations: ScoreHit[] = [], events: { start: number; kind: "kick" | "snare" | "hat" }[] = [];
  for (let beat = 0; beat < 8; beat++) {
    const timeMs = 147 + beat * beatMs;
    annotations.push({ timeMs, kind: beat % 2 ? "snare" : "kick" });
    events.push({ start: Math.round(timeMs * rate / 1000), kind: beat % 2 ? "snare" : "kick" });
    if (beat % 3 !== 1) events.push({ start: Math.round((timeMs + beatMs / 2) * rate / 1000), kind: "hat" });
  }
  let seed = 123456789;
  for (let i = 0; i < frames; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 0x80000000 - 1, t = i / rate;
    let value = 0;
    if (t >= 0.147 && t < 4.55) {
      value += 0.055 * (Math.sin(2 * Math.PI * 196 * t) + Math.sin(2 * Math.PI * 246.94 * t) + Math.sin(2 * Math.PI * 293.66 * t));
      value += 0.08 * Math.sin(2 * Math.PI * 98 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 2.75 * t));
      for (const event of events) {
        const u = (i - event.start) / rate;
        if (u < 0 || u > 0.25) continue;
        if (event.kind === "kick") value += 0.30 * Math.exp(-u * 12) * Math.sin(2 * Math.PI * (100 * u - 110 * u * u));
        if (event.kind === "snare") value += 0.18 * Math.exp(-u * 27) * noise + 0.12 * Math.exp(-u * 18) * Math.sin(2 * Math.PI * 190 * u);
        if (event.kind === "hat") value += 0.10 * Math.exp(-u * 80) * noise;
      }
    }
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  return { wav, annotations };
}

function ffmpeg(args: string[], encoding: "utf8" | "buffer" = "utf8") {
  const result = spawnSync("ffmpeg", ["-nostdin", ...args], { encoding: encoding === "utf8" ? "utf8" : undefined, maxBuffer: 16_000_000, windowsHide: true });
  expect(result.status, String(result.stderr)).toBe(0);
  return result;
}

// Measure onset from a band-limited output waveform, not from theoretical timestamps.
function onsetTimes(file: string, times: number[]): number[] {
  const output = ffmpeg(["-v", "error", "-i", file, "-af", "bandpass=f=3000:w=500:t=h", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1"], "buffer").stdout as Buffer;
  const rate = 44_100, window = 441; // 10 ms RMS bins
  const energies: number[] = [];
  for (let frame = 0; (frame + 1) * window * 4 <= output.length; frame++) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += output.readFloatLE((frame * window + i) * 4) ** 2;
    energies.push(Math.sqrt(sum / window));
  }
  return times.map(time => {
    const first = Math.max(0, Math.floor((time - 100) / 10)), last = Math.min(energies.length, Math.ceil((time + 100) / 10));
    const slice = energies.slice(first, last), peak = Math.max(...slice);
    expect(peak, `percussion near ${time}ms`).toBeGreaterThan(0.015);
    const index = slice.findIndex(value => value >= peak * 0.25);
    expect(index).toBeGreaterThanOrEqual(0);
    return (first + index) * 10;
  });
}

it.skipIf(process.env.GLINT_BEAT_SYNC_E2E !== "1")("compares beacon, unmarked and independent synthetic beat analyses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-analysis-"));
  try {
    const hits = score(), noPing = hits.filter(hit => hit.kind !== "ping"), independent = independentMusic();
    const fixtures = [
      { name: "marked.wav", wav: mixedMusic(hits), annotations: hits },
      { name: "no-ping.wav", wav: mixedMusic(noPing), annotations: noPing },
      { name: "independent.wav", wav: independent.wav, annotations: independent.annotations },
    ];
    const results = [];
    for (const fixture of fixtures) {
      const file = path.join(root, fixture.name); fs.writeFileSync(file, fixture.wav);
      const analysis = await analyzeNleAudioBeats({ name: fixture.name, startMs: 500, durationMs: 3500, media: { asset: () => file }, signal: new AbortController().signal });
      expect(analysis.scope).toBe("estimated-energy-peaks");
      const candidates = analysis.calibration.candidates.map((candidate: { bpm: number; offsetMs: number }) => ({ bpm: candidate.bpm, offsetMs: candidate.offsetMs, annotation: annotationMetrics(fixture.annotations, candidate) }));
      results.push({ name: fixture.name, annotations: fixture.annotations, candidates, analysis });
    }
    const baseline = annotationMetrics(independent.annotations, { bpm: 110, offsetMs: 0 });
    const oracle = annotationMetrics(independent.annotations, { bpm: 110, offsetMs: (147 - 500 + 60_000 / 110) % (60_000 / 110) });
    expect(oracle.maxErrorMs).toBeLessThanOrEqual(0.1);
    expect(baseline.medianErrorMs).toBeGreaterThan(100);
    const report = { scope: "synthetic score-time comparisons only; no render measured here", limitations: "Marked ping is audible to the estimator. Independent fixture uses 110 BPM, seeded noise percussion, syncopated hats, bass and chords with no measurement beacon. Score annotations are synthesis times; they are not measured acoustic onsets. Real music and arbitrary topology are untested.", results, independentFixedPhaseBaseline: baseline, independentOracleGrid: oracle };
    console.info("MOTION-08 analysis-only", JSON.stringify(report));
    if (process.env.GLINT_BEAT_MIX_EVIDENCE) {
      const destination = process.env.GLINT_BEAT_MIX_EVIDENCE + "-analysis-only";
      fs.mkdirSync(destination, { recursive: false });
      for (const fixture of fixtures) fs.copyFileSync(path.join(root, fixture.name), path.join(destination, fixture.name), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(destination, "measurement.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(process.env.GLINT_BEAT_SYNC_E2E !== "1")("measures candidates against the annotated score and rendered output against snapped cuts", async () => {
  const hits = score();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-mix-")), assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  try {
    fs.writeFileSync(path.join(assets, "music.wav"), mixedMusic(hits));
    for (const color of ["red", "blue"]) ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", path.join(assets, `${color}.png`)]);
    const grid = { bpm: 120, offsetMs: 200, subdivisions: 1 as const };
    const targets = [1200, 2200, 3200];
    const cuts = targets.map(time => nleSnap(time + 18, beatSnapCandidates(time + 18, grid), 25));
    expect(cuts).toEqual(targets);
    expect(nleSnap(1230, beatSnapCandidates(1230, grid), 25)).toBeNull();
    const projectForCuts = (cutPoints: number[]) => {
      const starts = [0, ...cutPoints], ends = [...cutPoints, 4000];
      return parseNleProject({ schemaVersion: 1, id: "mixed-beat", title: "混合音乐卡点", fps: 30, width: 640, height: 360, tracks: [
        { id: "v", kind: "video", name: "画面", clips: starts.map((startMs, i) => ({ id: `c${i}`, kind: "image", src: `assets/${i % 2 ? "blue" : "red"}.png`, startMs, durationMs: ends[i]! - startMs })) },
        { id: "a", kind: "audio", name: "自建混合音乐", clips: [{ id: "music", kind: "audio", src: "assets/music.wav", startMs: 500, trimStartMs: 500, durationMs: 3500 }] },
      ] });
    };
    const projectFile = path.join(root, "project.json"), output = path.join(root, "mixed.mp4");
    const analysis = await analyzeNleAudioBeats({ name: "music.wav", startMs: 500, durationMs: 3500, media: { asset: () => path.join(assets, "music.wav") }, signal: new AbortController().signal });
    expect(analysis.scope).toBe("estimated-energy-peaks");
    expect(analysis.calibration.status).toBe("candidates");
    const best = analysis.calibration.candidates[0];
    expect(Math.abs(best.bpm - 120)).toBeLessThan(1);
    expect(Math.abs(best.offsetMs - 200)).toBeLessThan(15);
    // Quantify every calibration candidate against the annotated arrangement. The
    // product ranks by peak-phase alignment; this scores each hypothesis against
    // the known onsets (median/max error and hit rate) instead of trusting the rank.
    const scored = analysis.calibration.candidates.map((candidate: { bpm: number; offsetMs: number; alignment: number; matchedPeaks: number; medianErrorMs: number | null }) => ({
      bpm: candidate.bpm, offsetMs: candidate.offsetMs, alignment: candidate.alignment, matchedPeaks: candidate.matchedPeaks, productMedianErrorMs: candidate.medianErrorMs,
      annotation: annotationMetrics(hits, candidate),
    }));
    const chosen = scored[0]!;
    expect(chosen.annotation.hitCount, `best candidate hits the annotated score: ${JSON.stringify(chosen)}`).toBeGreaterThanOrEqual(Math.ceil(chosen.annotation.onsets * 0.9));
    expect(chosen.annotation.medianErrorMs, JSON.stringify(chosen)).toBeLessThanOrEqual(25);
    expect(chosen.annotation.maxErrorMs, JSON.stringify(chosen)).toBeLessThanOrEqual(HIT_TOLERANCE_MS);
    for (const other of scored.slice(1)) {
      expect(other.annotation.medianErrorMs, `product ranking must hold against the annotated score: ${JSON.stringify({ chosen, other })}`).toBeGreaterThanOrEqual(chosen.annotation.medianErrorMs);
    }
    const proposedGrid = calibrationToManualGrid(best, 500)!;
    const estimatedCuts = targets.map(time => nleSnap(time + 18, beatSnapCandidates(time + 18, proposedGrid), 25));
    expect(estimatedCuts.every((time, i) => time !== null && Math.abs(time - targets[i]!) <= 20)).toBe(true);
    fs.writeFileSync(projectFile, JSON.stringify(projectForCuts(targets)));
    const estimatedProjectFile = path.join(root, "estimated-project.json"), estimatedOutput = path.join(root, "estimated.mp4");
    const actualEstimatedCuts = estimatedCuts as number[];
    fs.writeFileSync(estimatedProjectFile, JSON.stringify(projectForCuts(actualEstimatedCuts)));
    const estimatedProject = JSON.parse(fs.readFileSync(estimatedProjectFile, "utf8"));
    expect(estimatedProject.tracks[0].clips.slice(1).map((clip: { startMs: number }) => clip.startMs)).toEqual(actualEstimatedCuts);
    await renderNle({ projectFile, assetsDir: assets, out: output, encoding: "draft" });
    await renderNle({ projectFile: estimatedProjectFile, assetsDir: assets, out: estimatedOutput, encoding: "draft" });
    const sceneTimes = (file: string) => [...String(ffmpeg(["-v", "info", "-i", file, "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"]).stderr).matchAll(/pts_time:([\d.]+)/g)].map(match => Number(match[1]) * 1000);
    const visualMs = sceneTimes(output), estimatedVisualMs = sceneTimes(estimatedOutput);
    const sourceMs = onsetTimes(path.join(assets, "music.wav"), targets);
    const audioMs = onsetTimes(output, targets);
    expect(() => onsetTimes(output, [1450])).toThrow(); // Off-beat has no 3 kHz percussion.
    expect(visualMs).toHaveLength(targets.length);
    const measured = targets.map((scoreMs, i) => ({ scoreMs, cutMs: visualMs[i]!, sourceOnsetMs: sourceMs[i]!, outputOnsetMs: audioMs[i]!, sourceToOutputMs: audioMs[i]! - sourceMs[i]!, audioToVideoMs: visualMs[i]! - audioMs[i]! }));
    for (const item of measured) {
      expect(Math.abs(item.cutMs - item.scoreMs), JSON.stringify(item)).toBeLessThanOrEqual(34);
      expect(Math.abs(item.sourceToOutputMs), JSON.stringify(item)).toBeLessThanOrEqual(30);
      expect(Math.abs(item.audioToVideoMs), JSON.stringify(item)).toBeLessThanOrEqual(50);
    }
    expect(estimatedVisualMs).toHaveLength(targets.length);
    const estimatedAudioMs = onsetTimes(estimatedOutput, targets);
    const estimatedMeasured = targets.map((scoreMs, i) => ({ scoreMs, plannedCutMs: actualEstimatedCuts[i]!, visualMs: estimatedVisualMs[i]!, outputOnsetMs: estimatedAudioMs[i]!, candidateErrorMs: actualEstimatedCuts[i]! - scoreMs, renderErrorMs: rounded(estimatedVisualMs[i]! - actualEstimatedCuts[i]!), visualToScoreMs: rounded(estimatedVisualMs[i]! - scoreMs), audioToVideoMs: rounded(estimatedVisualMs[i]! - estimatedAudioMs[i]!) }));
    for (const item of estimatedMeasured) {
      expect(Math.abs(item.renderErrorMs), JSON.stringify(item)).toBeLessThanOrEqual(34);
      expect(Math.abs(item.audioToVideoMs), JSON.stringify(item)).toBeLessThanOrEqual(55);
    }
    console.info("MOTION-08 annotated mixed score measurement", JSON.stringify({ chosen, scored, measured, estimatedMeasured }));
    if (process.env.GLINT_BEAT_MIX_EVIDENCE) {
      fs.mkdirSync(process.env.GLINT_BEAT_MIX_EVIDENCE, { recursive: false });
      for (const file of [output, projectFile, estimatedOutput, estimatedProjectFile, path.join(assets, "music.wav")]) fs.copyFileSync(file, path.join(process.env.GLINT_BEAT_MIX_EVIDENCE, path.basename(file)), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(process.env.GLINT_BEAT_MIX_EVIDENCE, "measurement.json"), JSON.stringify({
        generatedAt: new Date().toISOString(),
        fixture: "self-composed synthetic mixed music; annotations are the programmed onsets of this arrangement (kick/snare/ping; backbeat snare deliberately +14 ms behind the grid), not ground truth from real recordings — real-music accuracy is out of scope and not extrapolated",
        toleranceMs: HIT_TOLERANCE_MS,
        score: {
          bpm: BPM, beatMs: BEAT_MS, offsetMs: GRID_OFFSET_MS, beats: BEAT_COUNT, snareDragMs: SNARE_DRAG_MS,
          headCapMs: HEAD_CAP_MS, tailCapFromMs: TAIL_CAP_MS, arrangementEndMs: ARRANGEMENT_END_MS,
          chords: { A_major: "0.2-2.2s", D_major: "2.2-3.8s" }, arp: "eighth notes cycling 440/523.25/659.25/587.33 Hz",
          clip: { startMs: CLIP_START_MS, trimStartMs: 500, durationMs: CLIP_DURATION_MS }, analysisWindowMs: [CLIP_START_MS, CLIP_START_MS + CLIP_DURATION_MS],
        },
        annotations: hits,
        candidates: scored,
        proposedGrid, estimatedCuts, trueCutControl: measured, estimatedRender: estimatedMeasured, analysis,
        measurementLimits: "Audio onset probe uses 10ms RMS bins and a 25% local-peak threshold on 3kHz pings, not sample-accurate ground truth; video scene cuts quantized to 30fps. Pings are part of analyzed audio and may affect calibration. No real music or arbitrary shape topology validated.",
      }, null, 2));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 240_000);
