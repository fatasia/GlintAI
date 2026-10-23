import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkDelivery, runDeliveryCheck, type DeliveryCheckInput } from "./delivery-check";
import { captureProcess } from "./frame-diff";
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
const failures = (report: Awaited<ReturnType<typeof checkDelivery>>) => report.checks.filter(check => !check.pass);
const previousExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = previousExitCode; });

// No media-tool mocks: every fixture and decoder/measurement invocation is real.
describe.skipIf(!installed)("delivery check with installed FFmpeg", () => {
  let root: string;
  const files: Record<string, string> = {};
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-delivery-"));
    const fixture = async (name: string, audio?: string, filter?: string) => {
      const file = path.join(root, `${name} space.mp4`);
      await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=12:duration=4",
        ...(audio ? ["-f", "lavfi", "-i", audio, ...(filter ? ["-af", filter] : []), "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "4", "-movflags", "+faststart", file]);
      files[name] = file;
    };
    await fixture("noaudio");
    await fixture("normalized", "sine=frequency=1000:sample_rate=48000:duration=4", "volume=2,loudnorm=I=-16:TP=-1:LRA=7");
    await fixture("quiet", "sine=frequency=1000:sample_rate=48000:duration=4", "volume=0.01");
    await fixture("silent", "anullsrc=r=48000:cl=stereo");
    await fixture("peak", "sine=frequency=1000:sample_rate=48000:duration=4", "volume=4");
    files.multiaudio = path.join(root, "multiple-audio.mp4");
    await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-i", files.normalized!, "-i", files.silent!, "-map", "0:v:0", "-map", "0:a:0", "-map", "1:a:0", "-c", "copy", files.multiaudio]);
    files.audioonly = path.join(root, "audio-only.mp4");
    await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-i", files.normalized!, "-vn", "-c:a", "copy", files.audioonly]);
    files.corrupt = path.join(root, "corrupt.mp4");
    const corrupt = Buffer.from(fs.readFileSync(files.normalized!));
    const mdat = corrupt.indexOf(Buffer.from("mdat"));
    if (mdat < 0) throw new Error("Fixture has no media payload");
    corrupt.fill(0xff, mdat + 4);
    fs.writeFileSync(files.corrupt, corrupt);
  }, 30_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("allows no audio by default/optional, rejects required, and records real metadata/hash", async () => {
    const before = fs.readdirSync(root).sort();
    const report = await checkDelivery({ videoPath: files.noaudio! });
    expect(failures(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.audioLoudness).toBeUndefined();
    expect(report.duration).toBeCloseTo(4, 1);
    expect(report.streams).toEqual([expect.objectContaining({ type: "video", width: 64, height: 48, duration: 4 })]);
    expect(report.sha256).toBe(createHash("sha256").update(fs.readFileSync(files.noaudio!)).digest("hex"));
    expect(report.bytes).toBe(fs.statSync(files.noaudio!).size);
    expect((await checkDelivery({ videoPath: files.noaudio!, audio: "optional" })).pass).toBe(true);
    expect((await checkDelivery({ videoPath: files.noaudio!, audio: "forbidden" })).pass).toBe(true);
    const required = await checkDelivery({ videoPath: files.noaudio!, audio: "required" });
    expect(failures(required)).toEqual([expect.objectContaining({ name: "audio-policy" })]);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  }, 20_000);

  it("measures normalized delivered audio, enforces forbidden policy, and never changes input", async () => {
    const before = fs.readFileSync(files.normalized!), stat = fs.statSync(files.normalized!);
    const report = await checkDelivery({ videoPath: files.normalized!, audio: "required" });
    expect(failures(report)).toEqual([]);
    expect(report.audioLoudness).toHaveLength(1);
    expect(report.audioLoudness![0]!.integratedLufs).toBeCloseTo(-16, 0);
    expect(report.audioLoudness![0]!.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(report.streams.find(stream => stream.type === "audio")?.loudness).toEqual(report.audioLoudness![0]);
    expect(report.checks.find(check => check.name === "decode")?.detail).toContain("visual quality not assessed");
    expect(fs.readFileSync(files.normalized!)).toEqual(before);
    expect(fs.statSync(files.normalized!).mtimeMs).toBe(stat.mtimeMs);
    expect(failures(await checkDelivery({ videoPath: files.normalized!, audio: "forbidden" }))).toContainEqual(expect.objectContaining({ name: "audio-policy" }));
  }, 15_000);

  it.each(["quiet", "silent"])("rejects present %s audio even when optional", async name => {
    const report = await checkDelivery({ videoPath: files[name]!, audio: "optional" });
    expect(report.pass).toBe(false);
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "loudness:1" }));
    if (name === "silent") {
      expect(report.audioLoudness![0]).toMatchObject({ integratedLufs: null, silent: true });
      expect(failures(await checkDelivery({ videoPath: files[name]!, audio: "required" }))).toContainEqual(expect.objectContaining({ name: "loudness:1" }));
      expect(JSON.stringify(report)).not.toContain("Infinity");
    }
  }, 15_000);

  it("enforces true peak independently and supports explicit loudness targets", async () => {
    const report = await checkDelivery({ videoPath: files.peak!, targetLufs: -10, toleranceLu: 10, maxTruePeakDbtp: -9 });
    expect(report.checks.find(check => check.name === "loudness:1")?.pass).toBe(true);
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "true-peak:1" }));
    const adjusted = await checkDelivery({ videoPath: files.peak!, targetLufs: report.audioLoudness![0]!.integratedLufs!, toleranceLu: 0, maxTruePeakDbtp: 0 });
    expect(failures(adjusted)).toEqual([]);
  }, 15_000);

  it("fails actual full decode on corrupt packets despite readable stream metadata", async () => {
    const report = await checkDelivery({ videoPath: files.corrupt! });
    expect(report.pass).toBe(false);
    expect(report.streams.some(stream => stream.type === "video")).toBe(true);
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "decode" }));
    const junk = path.join(root, "junk.mp4");
    fs.writeFileSync(junk, "not media");
    expect(failures(await checkDelivery({ videoPath: junk }))).toContainEqual(expect.objectContaining({ name: "probe" }));
  });

  it("checks every delivered audio track and rejects audio-only containers", async () => {
    const report = await checkDelivery({ videoPath: files.multiaudio! });
    expect(report.audioLoudness).toHaveLength(2);
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "loudness:2" }));
    expect(report.audioLoudness![0]!.silent).toBe(false);
    expect(report.audioLoudness![1]!.silent).toBe(true);
    expect(failures(await checkDelivery({ videoPath: files.audioonly! }))).toContainEqual(expect.objectContaining({ name: "video" }));
  });

  function expectExited(pid: number | undefined): void {
    expect(pid).toBeTypeOf("number");
    expect(() => process.kill(pid!, 0)).toThrow();
  }
  it("handles pre-cancellation and kills an in-flight loudness subprocess", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(failures(await checkDelivery({ videoPath: files.normalized!, signal: controller.signal }))).toContainEqual(expect.objectContaining({ name: "cancelled" }));
    const active = new AbortController();
    const spawn = childProcess.spawn;
    let pid: number | undefined;
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
      const child = spawn(command, args, options);
      if (args.includes("loudnorm=print_format=json")) { pid = child.pid; setImmediate(() => active.abort()); }
      return child;
    }) as typeof childProcess.spawn);
    const report = await checkDelivery({ videoPath: files.normalized!, signal: active.signal });
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "cancelled" }));
    expectExited(pid);
  }, 15_000);

  it.each([captureProcess, runMediaProcess])("shared media helper kills/waits for aborted and timed-out real subprocesses (%#)", async helper => {
    const spy = vi.spyOn(childProcess, "spawn");
    const args = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=12", "-f", "null", "-"];
    await expect(helper("ffmpeg", args, { timeoutMs: 75 })).rejects.toThrow(/failed/);
    expectExited(spy.mock.results.at(-1)?.value.pid);
    const controller = new AbortController();
    const pending = helper("ffmpeg", args, { signal: controller.signal, timeoutMs: 5000 });
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow(/cancelled/);
    expectExited(spy.mock.results.at(-1)?.value.pid);
  });

  it.each(["probe", "measurement"])("reports an overall timeout during %s only after subprocess cleanup", async stage => {
    const spawn = childProcess.spawn, setTimer = globalThis.setTimeout;
    let pid: number | undefined, deadline: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 180_000 && !deadline) deadline = callback;
      return setTimer(callback, delay);
    }) as typeof setTimeout);
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
      const child = spawn(command, args, options);
      if (stage === "probe" ? command === "ffprobe" : args.includes("loudnorm=print_format=json")) {
        pid = child.pid; setImmediate(() => deadline!());
      }
      return child;
    }) as typeof childProcess.spawn);
    const report = await checkDelivery({ videoPath: files.normalized! });
    expect(failures(report)).toContainEqual(expect.objectContaining({ name: "timeout" }));
    expectExited(pid);
  });

  it("prints JSON, returns reports, uses canonical audio-policy, and sets exitCode=2 on failures", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pass = await runDeliveryCheck([`--video=${files.noaudio}`, "--audio-policy=optional"]);
    expect(pass.pass).toBe(true);
    expect(process.exitCode).toBe(previousExitCode);
    const fail = await runDeliveryCheck([`--video=${files.noaudio}`, "--audio=required", "--target-lufs=-16"]);
    expect(fail.pass).toBe(false);
    expect(process.exitCode).toBe(2);
    expect(log.mock.calls.map(call => JSON.parse(call[0] as string))).toEqual([pass, fail]);
  }, 10_000);
});

describe("delivery argument validation (no FFmpeg needed)", () => {
  it.each([
    { videoPath: "" }, { videoPath: "a.txt" }, { videoPath: "missing.mp4" },
    { videoPath: "x.mp4", audio: "anything" }, { videoPath: "x.mp4", targetLufs: NaN },
    { videoPath: "x.mp4", targetLufs: -71 }, { videoPath: "x.mp4", targetLufs: -4 },
    { videoPath: "x.mp4", toleranceLu: -1 }, { videoPath: "x.mp4", toleranceLu: 11 },
    { videoPath: "x.mp4", maxTruePeakDbtp: -10 }, { videoPath: "x.mp4", maxTruePeakDbtp: 1 },
  ])("rejects invalid input %j without spawning", async input => {
    const spy = vi.spyOn(childProcess, "spawn");
    expect((await checkDelivery(input as DeliveryCheckInput)).pass).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects empty files/directories and CLI malformed/duplicate/unknown values", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-delivery-invalid-"));
    try {
      const empty = path.join(root, "empty.mp4"), directory = path.join(root, "directory.mp4");
      fs.writeFileSync(empty, ""); fs.mkdirSync(directory);
      expect((await checkDelivery({ videoPath: empty })).pass).toBe(false);
      expect((await checkDelivery({ videoPath: directory })).pass).toBe(false);
      vi.spyOn(console, "log").mockImplementation(() => {});
      for (const args of [[], ["--video"], ["--video=x.mp4", "--unknown=x"], ["--video=a.mp4", "--video=b.mp4"], ["--video=x.mp4", "--audio="], ["--video=x.mp4", "--audio=optional", "--audio-policy=optional"], ["--video=x.mp4", "--target-lufs=nope"]]) {
        expect((await runDeliveryCheck(args)).pass).toBe(false);
        expect(process.exitCode).toBe(2);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
