import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseProject } from "@glintai/scenescript";
import { clipLongForm } from "./longform-clip";
import * as reference from "./reference-video";
import { runMediaProcess } from "./native-process";

const installed = ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { encoding: "utf8" }).status === 0);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixtureVideo(dir: string): Promise<string> {
  // testsrc2 keeps changing pixels so shot detection sees motion; 40s @ 10fps.
  const file = path.join(dir, "longform.mp4");
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=40", "-c:v", "mpeg4", "-q:v", "3", "-g", "25", file], {});
  return file;
}

describe.skipIf(!installed)("long-form clipping (real ffmpeg)", () => {
  it("keeps incomplete group measurements unknown and ranks them after measurable groups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clip-unknown-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const videoPath = path.join(dir, "source.mp4");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=12", "-c:v", "mpeg4", videoPath], {});
    const spy = vi.spyOn(reference, "analyzeReference").mockResolvedValue({
      source: { durationMs: 12000, width: 160, height: 90 },
      shots: [{ startMs: 0, endMs: 250, motion: null }, { startMs: 250, endMs: 4900, motion: 0.5 }, { startMs: 4900, endMs: 12000, motion: 0 }],
    } as never);
    try {
      const all = await clipLongForm({ videoPath, outDir: path.join(dir, "all"), minSeconds: 5, maxSeconds: 6, maxClips: 2 });
      expect(all.clips.map(clip => clip.motionScore)).toEqual([null, 0]);
      expect(JSON.parse(fs.readFileSync(all.manifestFile, "utf8")).clips[0].motionScore).toBeNull();
      expect(parseProject(JSON.parse(fs.readFileSync(all.clips[0]!.projectFile, "utf8"))).scenes[0]!.notes).toContain("无法测量");
      const limited = await clipLongForm({ videoPath, outDir: path.join(dir, "limited"), minSeconds: 5, maxSeconds: 6, maxClips: 1 });
      expect(limited.clips[0]!.startMs).toBe(4900);
      expect(limited.clips[0]!.motionScore).toBe(0);
    } finally { spy.mockRestore(); }
  }, 30000);
  it("cuts motion-ranked candidate clips with traceable source timecodes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clip-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const videoPath = await fixtureVideo(dir);
    const outDir = path.join(dir, "out");

    const result = await clipLongForm({ videoPath, outDir, minSeconds: 8, maxSeconds: 20, maxClips: 3 });

    expect(result.clips.length).toBeGreaterThanOrEqual(1);
    expect(result.clips.length).toBeLessThanOrEqual(3);
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
    expect(manifest.clips).toHaveLength(result.clips.length);
    for (const clip of result.clips) {
      // Duration lands inside the configured window.
      const seconds = (clip.endMs - clip.startMs) / 1000;
      expect(seconds).toBeGreaterThanOrEqual(8);
      expect(seconds).toBeLessThanOrEqual(20.5);
      // The cut file is a real decodable video.
      expect(fs.statSync(clip.file).size).toBeGreaterThan(10_000);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", clip.file], { encoding: "utf8" });
      expect(probe.status).toBe(0);
      expect(Number(JSON.parse(probe.stdout).format.duration)).toBeGreaterThan(3);
      // The project parses, references the local asset and keeps the source timecode.
      const project = parseProject(JSON.parse(fs.readFileSync(clip.projectFile, "utf8")));
      const scene = project.scenes[0]!;
      expect(scene.kind).toBe("video");
      if (scene.kind === "video") expect(scene.src).toBe(`assets/${clip.id}.mp4`);
      expect(scene.notes).toContain(`源时间码 ${clip.startMs}ms–${clip.endMs}ms`);
      expect(scene.notes).toContain(`源片 longform.mp4`);
      // S06 cover frame: every clip ships a decodable mid-segment JPEG.
      expect(clip.coverFile).toBeTruthy();
      const coverProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", clip.coverFile!], { encoding: "utf8" });
      expect(coverProbe.status).toBe(0);
      expect(JSON.parse(coverProbe.stdout).streams[0].codec_name).toBe("mjpeg");
    }
    // Candidates do not overlap and follow source order.
    for (let index = 1; index < result.clips.length; index++) {
      expect(result.clips[index]!.startMs).toBeGreaterThanOrEqual(result.clips[index - 1]!.endMs - 1);
    }
  }, 180_000);
});
