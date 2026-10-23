import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { buildReferenceProject, runReferenceProject, type ReferenceAnalysis } from "./reference-video";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const analysis = (overrides: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis => ({
  format: "glint-reference-analysis", version: 1,
  source: { name: "ref.mp4", sha256: "a".repeat(64), bytes: 100, durationMs: 5000, width: 1080, height: 1920, fps: 30 },
  shots: [{ id: "shot-001", startMs: 0, endMs: 1500, thumbnail: "shot-001.jpg", motion: 0.02 }, { id: "shot-002", startMs: 1500, endMs: 5000, thumbnail: "shot-002.jpg", motion: 0.2 }],
  limits: { threshold: 0.3, minShotMs: 500, maxShots: 12, maxShotsAllowed: 30, maxDurationMs: 600_000, maxBytes: 2 ** 31, maxDimension: 8192,
    maxPixels: 33_554_432, maxFps: 120, timeoutMs: 180_000, maxStderrBytes: 16 ** 8, detectedCuts: 1, mergedCuts: 0, omittedCuts: 0,
    shotCapReached: false, scope: "cuts-thumbnails-and-motion", recovery: "Heuristic cuts and reference thumbnails only." },
  inferred: true, ...overrides,
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-reference-project-")); roots.push(root);
  const directory = path.join(root, "analysis"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "analysis.json"), JSON.stringify(analysis()));
  for (const name of ["shot-001.jpg", "shot-002.jpg"]) fs.writeFileSync(path.join(directory, name), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  return { root, directory, project: path.join(directory, "project.json") };
}
describe("reference skeleton builder", () => {
  it("maps cuts to editable image scenes with honest inferred narration and vertical aspect", () => {
    const project = buildReferenceProject(analysis());
    expect(project.aspect).toBe("9:16");
    expect(project.scenes).toHaveLength(2);
    expect(project.scenes[0]).toMatchObject({ id: "ref-shot-001", kind: "image", src: "assets/reference-shot-001.jpg", narration: { durationMs: 1500 } });
    expect(project.scenes[1]).toMatchObject({ id: "ref-shot-002", narration: { durationMs: 3500 } });
    expect(project.scenes[0]!.narration.text).toContain("参考镜头 1");
    expect(project.scenes[0]!.narration.text).toContain("请替换");
    // Calm reference frame → slow push; busy reference frame → hold still.
    expect(project.scenes[0]!.camera).toEqual({ type: "push", intensity: 0.25 });
    expect(project.scenes[1]!.camera).toEqual({ type: "static" });
    expect(parseProject(project)).toEqual(project);
  });
  it("rejects malformed reports and unsafe thumbnails instead of inventing scenes", () => {
    for (const bad of [
      { ...analysis(), shots: [] },
      { ...analysis(), shots: [{ id: "a", startMs: 0, endMs: 10, thumbnail: "../x.jpg" }] },
      { ...analysis(), shots: [{ id: "a", startMs: 0, endMs: 10, thumbnail: "shot-001.jpg" }, { id: "b", startMs: 10, endMs: 20, thumbnail: "shot-001.jpg" }] },
      { ...analysis(), shots: [{ id: "a", startMs: 10, endMs: 10, thumbnail: "shot-001.jpg" }] },
      { ...analysis(), format: "other" },
      { ...analysis(), version: 2 },
    ] as unknown as ReferenceAnalysis[]) expect(() => buildReferenceProject(bad)).toThrow();
  });
});
describe("reference project publication", () => {
  it("copies reference frames beside the project and refuses to overwrite existing work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { directory, project } = setup();
    await runReferenceProject([`--analysis=${path.join(directory, "analysis.json")}`, `--out=${project}`]);
    const written = parseProject(JSON.parse(fs.readFileSync(project, "utf8")));
    expect(written.scenes).toHaveLength(2);
    expect(fs.readFileSync(path.join(directory, "assets", "reference-shot-001.jpg"))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).inferred).toBe(true);
    await expect(runReferenceProject([`--analysis=${path.join(directory, "analysis.json")}`, `--out=${project}`])).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(project, "utf8")).toContain("参考重建");
  });
  it("fails before publication when a frame is missing or the analysis is invalid", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { directory, project } = setup();
    fs.rmSync(path.join(directory, "shot-002.jpg"));
    await expect(runReferenceProject([`--analysis=${path.join(directory, "analysis.json")}`, `--out=${project}`])).rejects.toThrow(/missing/);
    expect(fs.existsSync(project)).toBe(false);
    const broken = path.join(directory, "broken.json"); fs.writeFileSync(broken, "{");
    await expect(runReferenceProject([`--analysis=${broken}`, `--out=other.json`])).rejects.toThrow(/Cannot read/);
  });
});
