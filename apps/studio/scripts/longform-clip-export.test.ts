// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mockLlm } from "@glintai/llm";
import { writeClipCopy } from "./clip-copy";
import { exportClipsBatch } from "./longform-clip-export";
import { runMediaProcess } from "./native-process";

const installed = ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { encoding: "utf8" }).status === 0);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function makeClip(dir: string, id: string): Promise<{ file: string; coverFile: string }> {
  // testsrc2 像素持续变化；2.5s 短片 + 中点 JPEG，模拟 glint clip 产物。
  const file = path.join(dir, "assets", `${id}.mp4`);
  const coverFile = path.join(dir, "assets", `${id}.jpg`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=2.5", "-c:v", "mpeg4", "-q:v", "3", file], {});
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", "1.25", "-i", file, "-frames:v", "1", "-q:v", "3", coverFile], {});
  return { file, coverFile };
}

async function fixtureManifest(dir: string): Promise<string> {
  const clips = [];
  for (const id of ["clip-01", "clip-02"]) {
    const { file, coverFile } = await makeClip(dir, id);
    clips.push({ id, startMs: 0, endMs: 2500, file: path.relative(dir, file), coverFile: path.relative(dir, coverFile) });
  }
  const manifestFile = path.join(dir, "clips.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ source: { videoPath: "long.mp4", durationMs: 5000 }, clips }));
  return manifestFile;
}

describe.skipIf(!installed)("CLIP-05 切片批量导出（真实 ffmpeg + mock 文案）", () => {
  it("切片→mock 文案→批量渲染→封面随片出包，清单可解析且产物可解码", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clip-export-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifestFile = await fixtureManifest(dir);
    // 文案走 clip-copy 既有 LLM 注入模式 + MockLlmProvider（零网关、零费用）。
    await writeClipCopy({ manifestFile, llm: mockLlm(JSON.stringify({ clips: [
      { id: "clip-01", title: "开场双镜头", hook: "第一眼抓住节奏", caption: "长片开场，运动评分高。" },
      { id: "clip-02", title: "收束段", hook: "稳住最后一口气", caption: "低运动落版。" },
    ] })) });

    const result = await exportClipsBatch({ manifestFile, outDir: dir, maxConcurrent: 2, encoding: "draft" });
    expect(result.failures).toEqual([]);
    expect(result.exports).toHaveLength(2);
    for (const entry of result.exports) {
      const mp4 = path.resolve(dir, entry.mp4);
      expect(fs.statSync(mp4).size).toBeGreaterThan(10_000);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", mp4], { encoding: "utf8" });
      expect(probe.status).toBe(0);
      expect(Number(JSON.parse(probe.stdout).format.duration)).toBeGreaterThan(2);
      expect(entry.copy).toMatchObject({ id: entry.id });
      expect(entry.copy!.title.length).toBeGreaterThan(0);
      expect(entry.cover).toBe(`exports/${entry.id}.cover.jpg`);
      const coverProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", path.resolve(dir, entry.cover!)], { encoding: "utf8" });
      expect(JSON.parse(coverProbe.stdout).streams[0].codec_name).toBe("mjpeg");
    }
    const stored = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
    expect(stored.exports).toHaveLength(2);
    expect(stored.failures).toEqual([]);
  }, 120_000);

  it("单片失败不中断整批（BATCH-04 语义），重跑只补失败片（BATCH-05 恢复）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clip-export-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifestFile = await fixtureManifest(dir);

    let attempts = 0;
    const flaky = async (clip: { id: string }) => {
      if (clip.id === "clip-01" && attempts === 0) { attempts += 1; throw new Error("注入的渲染失败"); }
      attempts += 1;
      const mp4 = path.join(dir, "exports", `${clip.id}.mp4`);
      fs.mkdirSync(path.dirname(mp4), { recursive: true });
      fs.writeFileSync(mp4, Buffer.alloc(1024, 1));
      return { mp4 };
    };
    const first = await exportClipsBatch({ manifestFile, outDir: dir, maxConcurrent: 2, renderer: flaky });
    expect(first.failures).toEqual([{ id: "clip-01", error: "注入的渲染失败" }]);
    expect(first.exports.map(entry => entry.id)).toEqual(["clip-02"]);
    // 手动放一个有效产物让恢复判定通过（done = 有记录且文件仍在）。
    fs.writeFileSync(path.join(dir, "exports", "clip-02.mp4"), Buffer.alloc(2048, 1));

    const second = await exportClipsBatch({ manifestFile, outDir: dir, maxConcurrent: 2, renderer: flaky });
    expect(second.doneSkipped).toBe(1);
    expect(second.failures).toEqual([]);
    expect(second.exports.map(entry => entry.id).sort()).toEqual(["clip-01", "clip-02"]);
    expect(attempts).toBe(3); // 首轮 2 次 + 补跑仅 clip-01
  });
});
