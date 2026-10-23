import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureProcess } from "./frame-diff";
import * as frameDiff from "./frame-diff";
import { runMediaProcess } from "./native-process";
import * as nativeProcess from "./native-process";
import { analyzeReference, runReferenceVideo, type ReferenceAnalysis } from "./reference-video";

const roots: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-reference-test-")); roots.push(dir); return dir; }
const exists = async (file: string) => !!await fs.lstat(file).catch(() => undefined);
afterAll(async () => { for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }); });
const installed = await Promise.all(["ffmpeg", "ffprobe"].map(async command => {
  try { await captureProcess(command, ["-version"], { timeoutMs: 5000 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}));
async function synthetic(dir: string, colors = ["red", "blue", "0x00ff00"], seconds = 1) {
  const file = path.join(dir, "reference video.mp4");
  const inputs = colors.flatMap(color => ["-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=20:d=${seconds}`]);
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", ...inputs, "-filter_complex",
    `${colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", file]);
  return file;
}
function coverage(report: ReferenceAnalysis) {
  expect(report.shots[0]!.startMs).toBe(0);
  expect(report.shots.at(-1)!.endMs).toBe(report.source.durationMs);
  report.shots.forEach((shot, index) => {
    expect(shot.endMs).toBeGreaterThan(shot.startMs);
    if (index) expect(shot.startMs).toBe(report.shots[index - 1]!.endMs);
    expect(shot.thumbnail).toMatch(/^shot-\d{3}\.jpg$/);
  });
}

describe("motion reference (frames only)", () => {
  it("reports low motion for a still shot and higher motion for moving footage", async () => {
    const dir = await root(), stillOut = path.join(dir, "still"), movingOut = path.join(dir, "moving");
    const still = path.join(dir, "still.mp4"), moving = path.join(dir, "moving.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=20:d=2", "-c:v", "mpeg4", "-q:v", "2", still]);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=20:d=2", "-c:v", "mpeg4", "-q:v", "2", moving]);
    const a = await analyzeReference({ videoPath: still, outDir: stillOut, minShotMs: 500, maxShots: 1 });
    const b = await analyzeReference({ videoPath: moving, outDir: movingOut, minShotMs: 500, maxShots: 1 });
    expect(a.shots[0]!.motion).toBeLessThan(0.01);
    expect(b.shots[0]!.motion).toBeGreaterThan(0.05);
    expect(a.limits.scope).toBe("cuts-thumbnails-and-motion");
  });
});describe("reference validation and exclusive output", () => {
  it.each([{ threshold: -1 }, { threshold: 1.1 }, { threshold: NaN }, { maxShots: 0 }, { maxShots: 31 }, { maxShots: 1.5 }, { minShotMs: 0 }, { minShotMs: Infinity }])("rejects invalid limits %j before writing", async limits => {
    const dir = await root(), outDir = path.join(dir, "analysis");
    await expect(analyzeReference({ videoPath: path.join(dir, "missing.mp4"), outDir, ...limits })).rejects.toThrow();
    expect(await exists(outDir)).toBe(false);
  });
  it.each(["https://example.com/video.mp4", "file:///tmp/video.mp4", "pipe:0", "\\\\server\\share\\video.mp4", "//server/share/video.mp4"])("refuses nonlocal input %s", async videoPath => {
    const dir = await root();
    await expect(analyzeReference({ videoPath, outDir: path.join(dir, "out") })).rejects.toThrow(/local/);
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("refuses an existing directory without changing its files", async () => {
    const dir = await root(), outDir = path.join(dir, "existing");
    await fs.mkdir(outDir); await fs.writeFile(path.join(outDir, "keep.txt"), "do not touch");
    await expect(analyzeReference({ videoPath: path.join(dir, "missing.mp4"), outDir })).rejects.toThrow();
    expect(await fs.readFile(path.join(outDir, "keep.txt"), "utf8")).toBe("do not touch");
    expect(await fs.readdir(outDir)).toEqual(["keep.txt"]);
  });
  it("refuses an existing file and never modifies it", async () => {
    const dir = await root(), outDir = path.join(dir, "keep.txt"); await fs.writeFile(outDir, "original");
    await expect(analyzeReference({ videoPath: path.join(dir, "missing.mp4"), outDir })).rejects.toThrow();
    expect(await fs.readFile(outDir, "utf8")).toBe("original");
  });
  it("cleans a missing source without leaving staging or final outputs", async () => {
    const dir = await root();
    await expect(analyzeReference({ videoPath: path.join(dir, "missing.mp4"), outDir: path.join(dir, "out") })).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("cancels before creating output", async () => {
    const dir = await root(), controller = new AbortController(); controller.abort();
    await expect(analyzeReference({ videoPath: path.join(dir, "missing.mp4"), outDir: path.join(dir, "out"), signal: controller.signal })).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("rejects source sizes over 2 GiB before invoking media tools", async () => {
    const dir = await root(), videoPath = path.join(dir, "large.mp4"), handle = await fs.open(videoPath, "w");
    try { await handle.truncate(2 * 1024 ** 3 + 1); } finally { await handle.close(); }
    const spy = vi.spyOn(frameDiff, "captureProcess");
    try { await expect(analyzeReference({ videoPath, outDir: path.join(dir, "out") })).rejects.toThrow(/2 GiB/); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["large.mp4"]);
  });
  it.each([
    { duration: "601", width: 160, height: 90, fps: "20/1" },
    { duration: "NaN", width: 160, height: 90, fps: "20/1" },
    { duration: "1", width: 9000, height: 90, fps: "20/1" },
    { duration: "1", width: 8192, height: 8192, fps: "20/1" },
    { duration: "1", width: 160, height: 90, fps: "121/1" },
    { duration: "1", width: 160, height: 90, fps: "0/0" },
  ])("rejects unsupported probe metadata %j and cleans outputs", async sample => {
    const dir = await root(), videoPath = path.join(dir, "source.mp4"); await fs.writeFile(videoPath, "fixture");
    const spy = vi.spyOn(frameDiff, "captureProcess").mockResolvedValue(Buffer.from(JSON.stringify({ format: { duration: sample.duration }, streams: [{ width: sample.width, height: sample.height, avg_frame_rate: sample.fps }] })));
    try { await expect(analyzeReference({ videoPath, outDir: path.join(dir, "out") })).rejects.toThrow(/duration|metadata/); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["source.mp4"]);
  });
  it("requires explicit CLI input and new output paths", async () => {
    await expect(runReferenceVideo([])).rejects.toThrow(/--video.*--out/);
  });
});

describe.skipIf(!installed.every(Boolean))("real local ffmpeg reference analysis", () => {
  it("detects red/blue/green cuts, preserves source and produces relative JPEG references", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "analysis");
    const before = await fs.readFile(videoPath), beforeStat = await fs.stat(videoPath);
    const report = await analyzeReference({ videoPath, outDir });
    expect(report.format).toBe("glint-reference-analysis"); expect(report.version).toBe(1); expect(report.inferred).toBe(true);
    expect(report.source).toMatchObject({ name: "reference video.mp4", sha256: createHash("sha256").update(before).digest("hex"), bytes: before.length, durationMs: 3000, width: 160, height: 90, fps: 20 });
    expect(report.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 1000], [1000, 2000], [2000, 3000]]);
    expect(report.limits).toMatchObject({ threshold: 0.3, minShotMs: 500, maxShots: 12, detectedCuts: 2, mergedCuts: 0, omittedCuts: 0, shotCapReached: false, scope: "cuts-thumbnails-and-motion" });
    expect(report.limits.recovery).toMatch(/no original editable layers, identity, rig, or structure/i);
    coverage(report);
    for (const shot of report.shots) {
      const bytes = await fs.readFile(path.join(outDir, shot.thumbnail)); expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const dimensions = await captureProcess("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path.join(outDir, shot.thumbnail)]);
      expect(JSON.parse(dimensions.toString()).streams[0]).toMatchObject({ width: 320, height: 180 });
    }
    const json = await fs.readFile(path.join(outDir, "analysis.json"), "utf8"); expect(JSON.parse(json)).toEqual(report);
    expect(json).not.toContain(dir); expect(json).not.toMatch(/https?:\/\//);
    expect(await fs.readFile(videoPath)).toEqual(before); expect((await fs.stat(videoPath)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect((await fs.readdir(dir)).sort()).toEqual(["analysis", "reference video.mp4"]);
    const again = await analyzeReference({ videoPath, outDir: path.join(dir, "again") }); expect(again).toEqual(report);
  }, 30_000);
  it("covers a no-cut video as one shot, including video shorter than minShotMs", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red"], 0.2);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(report.shots).toHaveLength(1); expect(report.source.durationMs).toBe(200); coverage(report);
    expect(report.limits).toMatchObject({ detectedCuts: 0, mergedCuts: 0, omittedCuts: 0 });
  }, 15_000);
  it("merges close cuts deterministically and explicitly reports omitted cuts at the cap", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red", "blue", "0x00ff00", "red", "blue", "0x00ff00", "red", "blue"], 0.2);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out"), maxShots: 2 });
    expect(report.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 600], [600, 1600]]);
    expect(report.limits).toMatchObject({ detectedCuts: 7, mergedCuts: 6, omittedCuts: 0, shotCapReached: false });
    const capped = await analyzeReference({ videoPath, outDir: path.join(dir, "cap"), minShotMs: 100, maxShots: 2 });
    expect(capped.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 200], [200, 1600]]);
    expect(capped.limits).toMatchObject({ detectedCuts: 7, mergedCuts: 0, omittedCuts: 6, shotCapReached: true }); coverage(capped);
  }, 30_000);
  it("accepts threshold endpoints and a one-shot cap", async () => {
    const dir = await root(), videoPath = await synthetic(dir);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "one"), threshold: 0, maxShots: 1 });
    expect(report.shots).toHaveLength(1); expect(report.limits.omittedCuts).toBe(2); coverage(report);
    const none = await analyzeReference({ videoPath, outDir: path.join(dir, "none"), threshold: 1 }); expect(none.shots).toHaveLength(1);
  }, 30_000);
  it("cleans corrupt input failure without deleting the source", async () => {
    const dir = await root(), videoPath = path.join(dir, "corrupt.mp4"); await fs.writeFile(videoPath, "not video");
    await expect(analyzeReference({ videoPath, outDir: path.join(dir, "out") })).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(["corrupt.mp4"]); expect(await fs.readFile(videoPath, "utf8")).toBe("not video");
  });
  it("cleans cancellation after exclusive output creation", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "out"), controller = new AbortController();
    const mkdir = fs.mkdir.bind(fs), spy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args); if (String(args[0]) === outDir) controller.abort(); return result;
    });
    try { await expect(analyzeReference({ videoPath, outDir, signal: controller.signal })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["reference video.mp4"]);
  }, 15_000);
  it("removes only its partial thumbnails when encoding fails", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "out");
    const spy = vi.spyOn(nativeProcess, "runMediaProcess").mockImplementation(async (_command, args) => {
      await fs.writeFile(args.at(-1)!, "partial jpeg"); throw new Error("encoder failed");
    });
    try { await expect(analyzeReference({ videoPath, outDir })).rejects.toThrow(/encoder failed/); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["reference video.mp4"]);
  }, 15_000);
  it("cancels a running thumbnail process and removes its reserved artifact", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "out"), controller = new AbortController(), real = nativeProcess.runMediaProcess;
    const spy = vi.spyOn(nativeProcess, "runMediaProcess").mockImplementation(async (...args) => {
      const pending = real(...args); controller.abort(); await pending;
    });
    try { await expect(analyzeReference({ videoPath, outDir, signal: controller.signal })).rejects.toThrow(/cancel|abort/i); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["reference video.mp4"]);
  }, 15_000);
  it("rejects a source modified during thumbnail generation", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "out"), real = nativeProcess.runMediaProcess;
    const spy = vi.spyOn(nativeProcess, "runMediaProcess").mockImplementation(async (...args) => {
      await real(...args); await fs.appendFile(videoPath, "source modified externally");
    });
    try { await expect(analyzeReference({ videoPath, outDir })).rejects.toThrow(/source changed/); }
    finally { spy.mockRestore(); }
    expect(await fs.readdir(dir)).toEqual(["reference video.mp4"]);
    expect((await fs.readFile(videoPath)).toString()).toContain("source modified externally");
  }, 15_000);
  it("allows only one concurrent caller to claim a new output", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "out");
    const results = await Promise.allSettled([analyzeReference({ videoPath, outDir }), analyzeReference({ videoPath, outDir })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(outDir, "analysis.json"), "utf8")).shots).toHaveLength(3);
    expect((await fs.readdir(dir)).sort()).toEqual(["out", "reference video.mp4"]);
  }, 15_000);
  it("does not recursively remove unexpected files on failure", async () => {
    const dir = await root(), videoPath = path.join(dir, "bad.mp4"), outDir = path.join(dir, "out"); await fs.writeFile(videoPath, "bad");
    const mkdir = fs.mkdir.bind(fs), spy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args); if (String(args[0]) === outDir) await fs.writeFile(path.join(outDir, "unexpected.txt"), "keep"); return result;
    });
    try { await expect(analyzeReference({ videoPath, outDir })).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await fs.readFile(path.join(outDir, "unexpected.txt"), "utf8")).toBe("keep");
    expect((await fs.readdir(dir)).sort()).toEqual(["bad.mp4", "out"]);
  });
});
