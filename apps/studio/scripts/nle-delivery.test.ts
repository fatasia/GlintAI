// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseNleProject } from "@glintai/scenescript";
import { assembleDeliveryPackage, buildNleSrt } from "./nle-delivery";
import { coverFrameIndex } from "./nle-render";
import { runMediaProcess } from "./native-process";

const installed = ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { encoding: "utf8" }).status === 0);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const project = parseNleProject({
  schemaVersion: 1, id: "deliver-demo", title: "交付样片", fps: 10, width: 320, height: 180,
  tracks: [
    { id: "v1", kind: "video", name: "主轨", clips: [{ id: "seg", kind: "video", src: "assets/seg.mp4", startMs: 0, durationMs: 2500 }] },
    { id: "t1", kind: "text", name: "字幕", clips: [
      { id: "cap-1", kind: "text", text: "开场第一句字幕", startMs: 200, durationMs: 900 },
      { id: "cap-2", kind: "text", text: "落版第二句", startMs: 1300, durationMs: 800 },
    ] },
  ],
});

async function fixtureVideo(dir: string): Promise<string> {
  const file = path.join(dir, "deliver-demo.mp4");
  // testsrc2 每帧都变色：不同帧抽出的封面字节必然不同（非首帧可判）。
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=2.5", "-c:v", "mpeg4", "-q:v", "3", file], {});
  return file;
}

describe("DELIVER-03 音频字幕封面交付", () => {
  it("coverFrameIndex：默认首帧、时间点换算帧号、超界夹住", () => {
    expect(coverFrameIndex(undefined, 30, 75)).toBe(0);
    expect(coverFrameIndex(0, 30, 75)).toBe(0);
    expect(coverFrameIndex(1200, 10, 25)).toBe(12);
    expect(coverFrameIndex(-5, 30, 75)).toBe(0);
    expect(coverFrameIndex(999_999, 10, 25)).toBe(24);
  });
  it("NLE 文字轨 → SRT：时间轴排序、起止正确", () => {
    const srt = buildNleSrt(project);
    expect(srt).toContain("1\n00:00:00,200 --> 00:00:01,100\n开场第一句字幕");
    expect(srt).toContain("2\n00:00:01,300 --> 00:00:02,100\n落版第二句");
    expect(srt.indexOf("开场第一句字幕")).toBeLessThan(srt.indexOf("落版第二句"));
  });
  it.skipIf(!installed)("交付包组装：MP4+SRT+封面齐活，非首帧封面与首帧字节不同，manifest 一致", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-delivery-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const video = await fixtureVideo(dir);
    const projectFile = path.join(dir, "project.json");
    fs.writeFileSync(projectFile, JSON.stringify(project));

    const first = await assembleDeliveryPackage({ projectFile, video, outDir: path.join(dir, "pack-first") });
    const mid = await assembleDeliveryPackage({ projectFile, video, coverAtMs: 1200, outDir: path.join(dir, "pack-mid") });
    for (const pack of [first, mid]) {
      expect(fs.statSync(pack.video).size).toBeGreaterThan(10_000);
      expect(fs.statSync(pack.srt).size).toBeGreaterThan(20);
      expect(pack.cues).toBe(2);
      const coverProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", pack.cover], { encoding: "utf8" });
      expect(JSON.parse(coverProbe.stdout).streams[0].codec_name).toBe("mjpeg");
      const manifest = JSON.parse(fs.readFileSync(pack.manifestFile, "utf8"));
      expect(manifest.cues).toBe(2);
      for (const entry of manifest.files) expect(entry.bytes).toBe(fs.statSync(path.join(pack.dir, entry.file)).size);
    }
    // 封面帧选择生效：1.2s 抽帧 ≠ 首帧（testsrc2 逐帧变色，字节必不同）。
    expect(fs.readFileSync(mid.cover)).not.toEqual(fs.readFileSync(first.cover));
    // 交付包内的成片可解码且时长与源一致。
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", mid.video], { encoding: "utf8" });
    expect(Number(JSON.parse(probe.stdout).format.duration)).toBeGreaterThan(2.4);
  }, 120_000);
  it.skipIf(!installed)("渲染回执封面优先：已有 <video>.cover.jpg 时不再抽帧", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-delivery-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const video = await fixtureVideo(dir);
    const receipt = video.replace(/\.mp4$/, ".cover.jpg");
    fs.writeFileSync(receipt, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const projectFile = path.join(dir, "project.json");
    fs.writeFileSync(projectFile, JSON.stringify(project));
    const pack = await assembleDeliveryPackage({ projectFile, video, coverAtMs: 1200, outDir: path.join(dir, "pack") });
    expect(fs.readFileSync(pack.cover)).toEqual(fs.readFileSync(receipt)); // 回执封面原样随包
  }, 60_000);
});
