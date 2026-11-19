import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyExport, runVerifyExport, type VerifyExportInput, type VerifyExportReport } from "./verify-export";
import { runMediaProcess } from "./native-process";

// Expose a spyable forwarding export; all subprocesses still use the real OS spawn.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => actual.spawn(...args) };
});

const installed = ["ffmpeg", "ffprobe"].every(command => {
  const result = childProcess.spawnSync(command, ["-version"], { stdio: "ignore" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return false;
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} -version failed (${result.status})`);
  return true;
});
const failures = (report: Awaited<ReturnType<typeof verifyExport>>) => report.checks.filter(check => !check.pass);
const previousExitCode = process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; });

// Real files and real decoders only; this suite adds spec assertions on top of the shared delivery engine.
describe.skipIf(!installed)("verify export with installed FFmpeg", () => {
  let root: string;
  let spec: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-verify-export-"));
    spec = path.join(root, "spec.mp4");
    await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=12:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", spec]);
    fs.copyFileSync(spec, path.join(root, "renamed.webm"));
  }, 30_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("passes a matching spec, keeps container proof, and always states the human remaining checks", async () => {
    const report = await verifyExport({ videoPath: spec, expect: { width: 64, height: 48, fps: 12, durationMs: 4000 } });
    expect(failures(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.container).toEqual({ family: "mp4", brandOk: true });
    expect(report.streams.find(stream => stream.type === "video")?.fps).toBeCloseTo(12, 3);
    expect(report.expect).toEqual({ width: 64, height: 48, fps: 12, durationMs: 4000 });
    expect(report.remainingChecks).toHaveLength(3);
    expect(report.remainingChecks.join("")).toContain("观看");
    expect(report.remainingChecks.join("")).toContain("实机");
  }, 20_000);

  it("enforces each spec dimension independently and honours the duration tolerance", async () => {
    const width = await verifyExport({ videoPath: spec, expect: { width: 1920 } });
    expect(failures(width)).toEqual([expect.objectContaining({ name: "spec:width" })]);
    const fps = await verifyExport({ videoPath: spec, expect: { fps: 30 } });
    expect(failures(fps)).toEqual([expect.objectContaining({ name: "spec:fps" })]);
    const near = await verifyExport({ videoPath: spec, expect: { fps: 12.03 } });
    expect(failures(near)).toEqual([]);
    const over = await verifyExport({ videoPath: spec, expect: { durationMs: 4600 } });
    expect(failures(over)).toEqual([expect.objectContaining({ name: "spec:duration" })]);
    const within = await verifyExport({ videoPath: spec, expect: { durationMs: 4600, durationToleranceMs: 700 } });
    expect(failures(within)).toEqual([]);
  }, 20_000);

  it("rejects a container whose bytes do not carry the family signature", async () => {
    const report = await verifyExport({ videoPath: path.join(root, "renamed.webm") });
    expect(report.container).toEqual({ family: "webm", brandOk: false });
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "container" }));
    expect(report.pass).toBe(false);
  }, 20_000);

  it("composes with delivery failure: corrupt-free policy failures still run spec checks", async () => {
    const report = await verifyExport({ videoPath: spec, audio: "required" });
    expect(failures(report)).toEqual([expect.objectContaining({ name: "audio-policy" })]);
    expect(report.checks.some(check => check.name === "decode" && check.pass)).toBe(true);
    expect(report.checks.some(check => check.name === "container" && check.pass)).toBe(true);
  }, 20_000);

  it("prints JSON once, returns reports, and sets exitCode=2 on failures", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pass = await runVerifyExport([`--video=${spec}`, "--expect-width=64", "--expect-fps=12", "--expect-duration-ms=4000"]);
    expect(pass.pass).toBe(true);
    expect(process.exitCode).toBe(previousExitCode);
    const fail = await runVerifyExport([`--video=${spec}`, "--expect-width=1"]);
    expect(fail.pass).toBe(false);
    expect(process.exitCode).toBe(2);
    expect(log.mock.calls.map(call => JSON.parse(call[0] as string))).toEqual([pass, fail]);
  }, 15_000);
});

describe("verify-export argument validation (no FFmpeg needed)", () => {
  it.each([
    { args: [] as string[] }, { args: ["--video"] }, { args: ["--video=x.mp4", "--unknown=1"] },
    { args: ["--video=a.mp4", "--video=b.mp4"] },
    { args: ["--video=x.mp4", "--expect-width=nope"] }, { args: ["--video=x.mp4", "--expect-fps=NaN"] },
    { args: ["--video=x.mp4", "--audio=optional", "--audio-policy=optional"] },
  ])("rejects invalid CLI $args without spawning", async ({ args }) => {
    const spy = vi.spyOn(childProcess, "spawn");
    const report: VerifyExportReport = await runVerifyExport(args);
    expect(report.pass).toBe(false);
    expect(report.checks[0]?.name).toEqual(expect.stringMatching(/^(arguments|input)$/));
    expect(report.container).toEqual({ family: "unknown", brandOk: false });
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects non-video inputs before any subprocess", async () => {
    const spy = vi.spyOn(childProcess, "spawn");
    expect((await verifyExport({ videoPath: "missing.mp4" } as VerifyExportInput)).pass).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
