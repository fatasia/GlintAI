import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Runs the local FFmpeg reference analysis and turns its cuts into an editable
 * project. Reference frames are copied into the media library so the project
 * renders like any other image scene. Everything is heuristic and explicitly
 * marked inferred; no original layers, rig or identity are recovered.
 */
export async function buildReferenceProjectFromVideo({ name, media, dataDir }) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(name)) throw Object.assign(new Error("Choose an MP4 from the media library"), { status: 400 });
  const source = media.asset(name);
  if (!source) throw Object.assign(new Error("Reference video not found in the media library"), { status: 404 });
  const staging = await fs.mkdtemp(path.join(dataDir ?? os.tmpdir(), "glint-reference-"));
  const outDir = path.join(staging, "analysis"); // analyzeReference creates its output directory exclusively
  try {
    const { analyzeReference, buildReferenceProject } = await import("../../studio/scripts/reference-video.ts");
    const { analyzeReferenceStyle, applyReferenceStyle } = await import("../../studio/scripts/reference-style.ts");
    const report = await analyzeReference({ videoPath: source, outDir, maxShots: 12 });
    const inferred = buildReferenceProject(report);
    // Style is a proposal derived from the same local frames: the user can still
    // change theme and timings in the editor. No layer, rig or identity recovery.
    const style = await analyzeReferenceStyle(source).catch(() => null);
    const durations = report.shots.map(shot => shot.endMs - shot.startMs).filter(ms => ms > 0).sort((a, b) => a - b);
    const medianShotMs = durations.length ? durations[Math.floor(durations.length / 2)] : style?.medianShotMs;
    const project = style ? applyReferenceStyle(inferred, style) : inferred;
    const id = randomBytes(4).toString("hex");
    const scenes = report.shots.map((shot, index) => {
      const libraryName = `ref-${id}-${String(index + 1).padStart(3, "0")}.jpg`;
      media.install(path.join(outDir, shot.thumbnail), libraryName);
      const scene = project.scenes[index];
      if (!scene) throw new Error("Reference analysis and project scenes disagree");
      return { ...scene, src: `assets/${libraryName}` };
    });
    return {
      project: { ...project, id: `reference-${id}`, title: "参考重建（推断）", scenes },
      shots: scenes.length,
      inferred: true,
      style: style ? { palette: style.palette.slice(0, 5), medianShotMs } : null,
      limits: { scope: report.limits.scope, mergedCuts: report.limits.mergedCuts, omittedCuts: report.limits.omittedCuts },
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
