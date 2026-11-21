import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureProcess } from "./frame-diff";
import * as frameDiff from "./frame-diff";
import { runMediaProcess } from "./native-process";
import * as nativeProcess from "./native-process";
import { analyzeReference, runReferenceVideo, reviewAdaptiveCandidates, selectAdaptiveCandidates, type ReferenceAnalysis } from "./reference-video";

// The annotated grammars and lottie samples are rendered fixtures kept outside
// git; tests that read them are skipped when they have not been prepared yet.
const fixturePresent = (...names: string[]) => names.every(name => existsSync(path.resolve(process.cwd(), name)));

const roots: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-reference-test-")); roots.push(dir); return dir; }
const exists = async (file: string) => !!await fs.lstat(file).catch(() => undefined);
// analyzeReference canonicalizes paths through fs.realpath, which on Windows
// expands 8.3 short names (RUNNER~1 -> runneradmin). Mocks that string-compare
// against the requested outDir would never match on such runners, so match by
// realpath identity instead of raw text.
const isSamePath = async (candidate: string, expected: string) => {
  const [left, right] = await Promise.all([fs.realpath(candidate).catch(() => undefined), fs.realpath(expected).catch(() => undefined)]);
  return left !== undefined && right !== undefined && path.normalize(left) === path.normalize(right);
};
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

describe("adaptive candidate review budget", () => {
  it("reviews a late cut despite more than 120 early flash candidates without promoting skipped candidates", async () => {
    const candidates = Array.from({ length: 150 }, (_, i) => ({ timeMs: 100 + i * 10, score: 0.8 }));
    candidates.push({ timeMs: 9500, score: 0.2 });
    const reviewed: number[] = [];
    const result = await reviewAdaptiveCandidates(candidates, 10000, async candidate => {
      reviewed.push(candidate.timeMs);
      return candidate.timeMs === 9500;
    });
    expect(reviewed).toHaveLength(120);
    expect(result).toEqual({ cuts: [9500], skipped: 31 });
    expect(selectAdaptiveCandidates([...candidates].reverse(), 10000).selected.map(c => c.timeMs)).toEqual(reviewed);
  });
  it("filters invalid boundaries, deduplicates equal millisecond candidates and keeps exactly 120", () => {
    const candidates = Array.from({ length: 120 }, (_, i) => ({ timeMs: i + 1, score: 0.1 }));
    candidates.push({ timeMs: 1, score: 0.9 }, { timeMs: 0, score: 1 }, { timeMs: 1000, score: 1 },
      { timeMs: NaN, score: 1 }, { timeMs: 5, score: NaN });
    const result = selectAdaptiveCandidates(candidates, 1000);
    expect(result.selected).toHaveLength(120);
    expect(result.skipped).toBe(0);
    expect(result.selected[0]).toEqual({ timeMs: 1, score: 0.9 });
    expect(selectAdaptiveCandidates([], 1000)).toEqual({ selected: [], skipped: 0 });
  });
  it("propagates a failed review without treating unchecked candidates as cuts", async () => {
    await expect(reviewAdaptiveCandidates([{ timeMs: 10, score: 1 }], 100, async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  });
});

describe("motion reference (frames only)", () => {
  it("reports low motion for a still shot and higher motion for moving footage", async () => {
    const dir = await root(), stillOut = path.join(dir, "still"), movingOut = path.join(dir, "moving");
    const still = path.join(dir, "still.mp4"), moving = path.join(dir, "moving.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=20:d=2", "-c:v", "mpeg4", "-q:v", "2", still]);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=20:d=2", "-c:v", "mpeg4", "-q:v", "2", moving]);
    const a = await analyzeReference({ videoPath: still, outDir: stillOut, minShotMs: 500, maxShots: 1 });
    const b = await analyzeReference({ videoPath: moving, outDir: movingOut, minShotMs: 500, maxShots: 1 });
    expect(a.shots[0]!.motion).not.toBeNull(); expect(a.shots[0]!.motion!).toBeLessThan(0.01);
    expect(b.shots[0]!.motion).not.toBeNull(); expect(b.shots[0]!.motion!).toBeGreaterThan(0.05);
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
  it("reports adaptive review truncation in both CLI and persisted analysis", async () => {
    const dir = await root(), videoPath = path.join(dir, "flashes.mp4"), outDir = path.join(dir, "out");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=35",
      "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n,5),1)'", "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const capture = frameDiff.captureProcess;
    const frames = vi.spyOn(frameDiff, "captureProcess").mockImplementation(async (command, args, options) =>
      args.includes("rawvideo") ? Buffer.alloc(64 * 36) : capture(command, args, options));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runReferenceVideo([`--video=${videoPath}`, `--out=${outDir}`, "--max-shots=1"]);
      const report: ReferenceAnalysis = JSON.parse(await fs.readFile(path.join(outDir, "analysis.json"), "utf8"));
      expect(report.limits.adaptiveCandidatesSkipped).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`${report.limits.adaptiveCandidatesSkipped} adaptive candidates skipped without flash review`));
      expect(frames.mock.calls.filter(([, args]) => args.includes("rawvideo")).length).toBeLessThanOrEqual(122);
    } finally { log.mockRestore(); frames.mockRestore(); }
  }, 30_000);
  it.skipIf(!fixturePresent("evidence/SKILL-01/grammars-20261028/whiteboard.mp4", "evidence/SKILL-01/grammars-20261028/blackboard.mp4", "evidence/SKILL-01/grammars-20261028/dark.mp4"))("recovers the three annotated low-score cuts without changing explicit threshold semantics", async () => {
    const dir = await root();
    const fixtureDir = path.resolve(process.cwd(), "evidence/SKILL-01/grammars-20261028");
    for (const name of ["whiteboard", "blackboard", "dark"]) {
      const videoPath = path.join(fixtureDir, `${name}.mp4`);
      const baseline = await analyzeReference({ videoPath, outDir: path.join(dir, `${name}-baseline`), threshold: 0.3 });
      const adaptive = await analyzeReference({ videoPath, outDir: path.join(dir, `${name}-adaptive`) });
      expect(baseline.shots.slice(1)).toHaveLength(0);
      expect(adaptive.shots.slice(1).map(shot => shot.startMs)).toEqual([2000]);
      expect(adaptive.limits).toMatchObject({ detector: "adaptive-temporal-v2", adaptiveCandidatesSkipped: 0 });
    }
  }, 120_000);
  it("rejects a variable-frame-rate one-frame flash using actual neighboring timestamps", async () => {
    const dir = await root(), videoPath = path.join(dir, "vfr-flash.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=5", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,40)',select='not(between(n,28,39))'", "-fps_mode", "vfr", "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const result = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(result.shots.map(shot => shot.startMs)).toEqual([0]);
  }, 30_000);
  it("retains a persistent cut following a variable-frame-rate gap", async () => {
    const dir = await root(), videoPath = path.join(dir, "vfr-cut.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=5", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(n,40)',select='not(between(n,28,39))'", "-fps_mode", "vfr", "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const result = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(result.shots.map(shot => shot.startMs)).toEqual([0, 2000]);
  }, 30_000);
  it.each([20, 30])("does not split duplicated-frame continuous translation at %i fps", async fps => {
    const dir = await root(), videoPath = path.join(dir, "translation.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `nullsrc=s=160x90:r=${fps}:d=3`, "-vf",
      "geq=lum='if(lt(abs(X-(20+floor(N/2)*2)),15),220,20)':cb=128:cr=128", "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(report.shots.map(shot => shot.startMs)).toEqual([0]);
  }, 60_000);
  it.skipIf(!fixturePresent("evidence/MOTION-05/lottie-import-20261027/lottie.mp4"))("does not split the original single-shot animation", async () => {
    const dir = await root(), videoPath = path.resolve(process.cwd(), "evidence/MOTION-05/lottie-import-20261027/lottie.mp4");
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(report.shots.map(shot => shot.startMs)).toEqual([0]);
    expect(report.limits.detectedCuts).toBe(0);
  }, 60_000);
  it("rejects gradual brightness changes while retaining a hard cut amidst duplicated-frame motion", async () => {
    const dir = await root(), fade = path.join(dir, "fade.mp4"), cut = path.join(dir, "cut.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=white:s=160x90:r=20:d=3", "-vf", "fade=t=in:st=0:d=1,fade=t=out:st=2:d=1", "-c:v", "mpeg4", "-q:v", "2", fade]);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=160x90:r=20:d=3", "-vf", "geq=lum='if(gte(N,30),if(lt(abs(X-(20+floor(N/2)*2)),15),20,200),if(lt(abs(X-(20+floor(N/2)*2)),15),220,20))':cb=128:cr=128", "-c:v", "mpeg4", "-q:v", "2", cut]);
    const a = await analyzeReference({ videoPath: fade, outDir: path.join(dir, "fade-out") });
    const b = await analyzeReference({ videoPath: cut, outDir: path.join(dir, "cut-out") });
    expect(a.shots.map(shot => shot.startMs)).toEqual([0]);
    expect(b.shots.map(shot => shot.startMs)).toEqual([0, 1500]);
  }, 60_000);
  it.each([1, 2, 3])("rejects a %i-frame flash in moving imagery", async count => {
    const dir = await root(), videoPath = path.join(dir, "flash.mp4");
    const moving = "if(lt(abs(X-(20+floor(N/2)*2)),14),210,25)";
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=160x90:r=24:d=3", "-vf", `geq=lum='if(between(N,24,${23 + count}),240,${moving})':cb=128:cr=128`, "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const result = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    expect(result.shots.map(shot => shot.startMs)).toEqual([0]);
  }, 45_000);
  it.each([
    ["fast", "if(gte(N,36),if(mod(N,2),200,80),30)", "continuing-change"],
    ["weak", "if(gte(N,36),(if(lt(abs(X-(25+floor(N/2)*2)),14),210,25))*0.95+5,if(lt(abs(X-(25+floor(N/2)*2)),14),210,25))", "weak-local-contrast"],
    ["jump", "if(lt(abs(X-(25+mod(floor(N/2)*3,75))),14),210,25)", "possible-spatial-displacement"],
  ])("reports the ambiguous %s transition without claiming a confirmed cut", async (name, expr, reason) => {
    const dir = await root(), videoPath = path.join(dir, `${name}.mp4`);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=160x90:r=24:d=4", "-vf", `geq=lum='${expr}':cb=128:cr=128`, "-c:v", "mpeg4", "-q:v", "2", videoPath]);
    const result = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
    const at = name === "jump" ? 2083 : 1500;
    expect(result.shots.slice(1).some(shot => Math.abs(shot.startMs - at) < 50)).toBe(false);
    expect(result.limits.uncertainCuts?.some(item => Math.abs(item.timeMs - at) < 50 && item.reason === reason)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, "out", "analysis.json"), "utf8")).limits.uncertainCuts).toEqual(result.limits.uncertainCuts);
  }, 60_000);
  it("leaves a genuine short return as reviewable rather than silently treating it as a flash", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red", "blue", "red"], 0.2);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out"), minShotMs: 50 });
    expect(report.limits.uncertainCuts?.some(item => Math.abs(item.timeMs - 200) <= 50 && item.reason === "short-return")).toBe(true);
  }, 30_000);
  it("rejects continuous motion and a one-frame flash while preserving a real cut", async () => {
    const dir = await root(), motion = path.join(dir, "motion.mp4"), flash = path.join(dir, "flash.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=20:d=3", "-c:v", "mpeg4", "-q:v", "2", motion]);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=gray:s=160x90:r=20:d=3", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,20)'", "-c:v", "mpeg4", "-q:v", "2", flash]);
    const naiveFlash = await analyzeReference({ videoPath: flash, outDir: path.join(dir, "flash-low-threshold"), threshold: 0.04 });
    expect(naiveFlash.shots.map(s => s.startMs)).toEqual([0, 1000]);
    for (const [name, videoPath] of [["motion", motion], ["flash", flash]] as const) {
      const result = await analyzeReference({ videoPath, outDir: path.join(dir, `${name}-out`) });
      expect(result.shots.map(s => s.startMs)).toEqual([0]);
    }
    const hard = await synthetic(dir, ["red", "blue"]);
    const result = await analyzeReference({ videoPath: hard, outDir: path.join(dir, "hard-out") });
    expect(result.shots.map(s => s.startMs)).toEqual([0, 1000]);
  }, 60_000);
  it("detects red/blue/green cuts, preserves source and produces relative JPEG references", async () => {
    const dir = await root(), videoPath = await synthetic(dir), outDir = path.join(dir, "analysis");
    const before = await fs.readFile(videoPath), beforeStat = await fs.stat(videoPath);
    const report = await analyzeReference({ videoPath, outDir });
    expect(report.format).toBe("glint-reference-analysis"); expect(report.version).toBe(1); expect(report.inferred).toBe(true);
    expect(report.source).toMatchObject({ name: "reference video.mp4", sha256: createHash("sha256").update(before).digest("hex"), bytes: before.length, durationMs: 3000, width: 160, height: 90, fps: 20 });
    expect(report.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 1000], [1000, 2000], [2000, 3000]]);
    expect(report.shots[0]!.boundaryChange).toBeNull();
    for (const shot of report.shots.slice(1)) {
      expect(shot.boundaryChange).toBeTypeOf("number");
      expect(shot.boundaryChange!).toBeGreaterThan(0);
      expect(shot.boundaryChange!).toBeLessThanOrEqual(1);
    }
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
    expect(report.shots[0]!.motion).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(dir, "out", "analysis.json"), "utf8")).shots[0].motion).toBeNull();
    expect(report.limits).toMatchObject({ detectedCuts: 0, mergedCuts: 0, omittedCuts: 0 });
  }, 15_000);
  it("merges close cuts deterministically and explicitly reports omitted cuts at the cap", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red", "blue", "0x00ff00", "red", "blue", "0x00ff00", "red", "blue"], 0.2);
    const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out"), threshold: 0.04, maxShots: 2 });
    expect(report.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 600], [600, 1600]]);
    expect(report.limits).toMatchObject({ detectedCuts: 7, mergedCuts: 6, omittedCuts: 0, shotCapReached: false });
    const capped = await analyzeReference({ videoPath, outDir: path.join(dir, "cap"), threshold: 0.04, minShotMs: 100, maxShots: 2 });
    expect(capped.shots.map(s => [s.startMs, s.endMs])).toEqual([[0, 200], [200, 1600]]);
    expect(capped.limits).toMatchObject({ detectedCuts: 7, mergedCuts: 0, omittedCuts: 6, shotCapReached: true }); coverage(capped);
  }, 30_000);
  it.each([0, 100, 2305])("preserves an incomplete %i-byte frame measurement as unavailable", async bytes => {
    const dir = await root(), videoPath = await synthetic(dir, ["red"]), capture = frameDiff.captureProcess;
    const spy = vi.spyOn(frameDiff, "captureProcess").mockImplementation(async (command, args, options) =>
      args.includes("rawvideo") ? Buffer.alloc(bytes) : capture(command, args, options));
    try {
      const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
      expect(report.shots[0]!.motion).toBeNull();
    } finally { spy.mockRestore(); }
  }, 15_000);
  it("records missing temporal frame evidence as uncertain instead of confirming a cut", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red", "blue"]), capture = frameDiff.captureProcess;
    const spy = vi.spyOn(frameDiff, "captureProcess").mockImplementation(async (command, args, options) =>
      args.includes("rawvideo") ? Buffer.alloc(100) : capture(command, args, options));
    try {
      const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out") });
      expect(report.shots).toHaveLength(1);
      expect(report.limits.uncertainCuts).toContainEqual({ timeMs: 1000, reason: "insufficient-temporal-frames" });
    } finally { spy.mockRestore(); }
  }, 15_000);
  it("marks the cut measurement unavailable when either sampled frame is incomplete", async () => {
    const dir = await root(), videoPath = await synthetic(dir, ["red", "blue"]), capture = frameDiff.captureProcess;
    const spy = vi.spyOn(frameDiff, "captureProcess").mockImplementation(async (command, args, options) =>
      args.includes("rawvideo") ? Buffer.alloc(100) : capture(command, args, options));
    try {
      const report = await analyzeReference({ videoPath, outDir: path.join(dir, "out"), threshold: 0.04 });
      expect(report.shots).toHaveLength(2);
      expect(report.shots[1]!.boundaryChange).toBeNull();
    } finally { spy.mockRestore(); }
  }, 15_000);
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
      const result = await mkdir(...args); if (await isSamePath(String(args[0]), outDir)) controller.abort(); return result;
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
      const result = await mkdir(...args); if (await isSamePath(String(args[0]), outDir)) await fs.writeFile(path.join(outDir, "unexpected.txt"), "keep"); return result;
    });
    try { await expect(analyzeReference({ videoPath, outDir })).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await fs.readFile(path.join(outDir, "unexpected.txt"), "utf8")).toBe("keep");
    expect((await fs.readdir(dir)).sort()).toEqual(["bad.mp4", "out"]);
  });
});
