import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { captureReferenceFrame, runReferenceOcr } from "./reference-ocr.mjs";

/**
 * Runs the local FFmpeg reference analysis and turns its cuts into an editable
 * project. Reference frames are copied into the media library so the project
 * renders like any other image scene. Everything is heuristic and explicitly
 * marked inferred; no original layers, rig or identity are recovered.
 */
export async function buildReferenceProjectFromVideo({ name, media, dataDir, signal = new AbortController().signal, ocr = false }) {
  signal.throwIfAborted();
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(name)) throw Object.assign(new Error("Choose an MP4 from the media library"), { status: 400 });
  const source = media.asset(name);
  if (!source) throw Object.assign(new Error("Reference video not found in the media library"), { status: 404 });
  const staging = await fs.mkdtemp(path.join(dataDir ?? os.tmpdir(), "glint-reference-"));
  const outDir = path.join(staging, "analysis"); // analyzeReference creates its output directory exclusively
  try {
    const { analyzeReference, buildReferenceProject } = await import("../../studio/scripts/reference-video.ts");
    const { analyzeReferenceStyle, applyReferenceStyle } = await import("../../studio/scripts/reference-style.ts");
    const report = await analyzeReference({ videoPath: source, outDir, maxShots: 12, signal });
    const inferred = buildReferenceProject(report);
    // Style is a proposal derived from the same local frames: the user can still
    // change theme and timings in the editor. No layer, rig or identity recovery.
    const style = await analyzeReferenceStyle(source, signal).catch(() => null);
    signal.throwIfAborted();
    const ocrResult = ocr ? await runReferenceOcr({ source, report, signal }) : undefined;
    signal.throwIfAborted();
    const durations = report.shots.map(shot => shot.endMs - shot.startMs).filter(ms => ms > 0).sort((a, b) => a - b);
    const medianShotMs = durations.length ? durations[Math.floor(durations.length / 2)] : style?.medianShotMs;
    const project = style ? applyReferenceStyle(inferred, style) : inferred;
    const id = randomBytes(4).toString("hex");
    const scenes = report.shots.map((shot, index) => {
      signal.throwIfAborted();
      const libraryName = `ref-${id}-${String(index + 1).padStart(3, "0")}.jpg`;
      media.install(path.join(outDir, shot.thumbnail), libraryName);
      const scene = project.scenes[index];
      if (!scene) throw new Error("Reference analysis and project scenes disagree");
      return { ...scene, src: `assets/${libraryName}` };
    });
    return {
      project: { ...project, id: `reference-${id}`, title: "参考重建（推断）", scenes },
      shots: scenes.length,
      source: { name, sha256: report.source.sha256, durationMs: report.source.durationMs },
      boundaries: report.shots.slice(1).map((shot, index) => ({ sceneId: scenes[index + 1].id, startMs: shot.startMs, change: shot.boundaryChange ?? null })),
      inferred: true,
      ...(ocrResult ? { ocr: ocrResult } : {}),
      style: style ? { palette: style.palette.slice(0, 5), medianShotMs } : null,
      limits: { scope: report.limits.scope, mergedCuts: report.limits.mergedCuts, omittedCuts: report.limits.omittedCuts, adaptiveCandidatesSkipped: report.limits.adaptiveCandidatesSkipped ?? 0, uncertainCuts: report.limits.uncertainCuts ?? [] },
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Refresh two midpoint samples from the same previously analyzed library video. */
export async function refreshReferenceFrames({ name, sha256, times, media, dataDir, signal = new AbortController().signal }) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(name) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || !Array.isArray(times) || times.length !== 2 || times.some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 600_000)) throw Object.assign(new Error("参考片或采样时间无效。"), { status: 400 });
  const source = media.asset(name);
  if (!source) throw Object.assign(new Error("原参考片已不在素材库。"), { status: 404 });
  const limited = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const digest = async () => {
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 300 * 1024 * 1024 || media.asset(name) !== source) throw new Error("参考片已变化，请重新分析。");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source, { signal: limited })) hash.update(chunk);
    return hash.digest("hex");
  };
  if (await digest() !== sha256) throw new Error("参考片已变化，请重新分析。");
  const frames = [];
  for (const at of times) frames.push(await captureReferenceFrame(source, at, limited));
  if (await digest() !== sha256) throw new Error("参考片已变化，请重新分析。");
  const staging = await fs.mkdtemp(path.join(dataDir ?? os.tmpdir(), "glint-reference-frames-"));
  try {
    const id = randomBytes(12).toString("hex"), names = [];
    for (let index = 0; index < frames.length; index++) {
      limited.throwIfAborted();
      const file = path.join(staging, `${index}.jpg`), filename = `ref-frame-${id}-${index}.jpg`;
      await fs.writeFile(file, frames[index], { flag: "wx" });
      media.install(file, filename);
      names.push(filename);
    }
    return { names, times };
  } finally {
    for (let index = 0; index < frames.length; index++) await fs.unlink(path.join(staging, `${index}.jpg`)).catch(() => {});
    await fs.rmdir(staging).catch(() => {});
  }
}
