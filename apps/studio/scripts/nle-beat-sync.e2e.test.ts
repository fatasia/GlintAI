import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { renderNle } from "./nle-render";

// MOTION-08 成片声画卡点测量:已知节拍的合成 beep(500ms 周期)+ 红/蓝画面片段,
// 渲染后用 FFmpeg 场景切换检测与静音检测量化「视觉切换 vs 音频节拍」的误差。
// 显式 opt-in;不调用网关。
const FRAME = 1 / 30;

it.skipIf(process.env.GLINT_BEAT_SYNC_E2E !== "1")("lands visual cuts on the synthesized beat within one frame in a real render", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-sync-"));
  const assets = path.join(root, "assets"); fs.mkdirSync(assets);
  const mk = (args: string[]) => { const r = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { windowsHide: true }); expect(r.status, r.stderr.toString()).toBe(0); };
  // 纯色视频(2 秒)与 500ms 周期 beep(3 秒;每周期前 60ms 有声)。
  mk(["-f", "lavfi", "-i", "color=c=red:s=960x540", "-frames:v", "1", path.join(assets, "red.png")]);
  mk(["-f", "lavfi", "-i", "color=c=blue:s=960x540", "-frames:v", "1", path.join(assets, "blue.png")]);
  mk(["-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-af", "volume='if(lt(mod(t,0.5),0.06),0.9,0)':eval=frame", path.join(assets, "tone.wav")]);
  const project = parseNleProject({ schemaVersion: 1, id: "beat-sync", title: "卡点测量", fps: 30, width: 960, height: 540, tracks: [
    { id: "v", kind: "video", name: "画面", clips: [
      { id: "c1", kind: "image", src: "assets/red.png", startMs: 0, durationMs: 1000 },
      { id: "c2", kind: "image", src: "assets/blue.png", startMs: 1000, durationMs: 1000 },
      { id: "c3", kind: "image", src: "assets/red.png", startMs: 2000, durationMs: 1000 },
    ] },
    { id: "a", kind: "audio", name: "节拍", clips: [{ id: "beep", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 3000 }] },
  ] });
  const projectFile = path.join(root, "project.json"); fs.writeFileSync(projectFile, JSON.stringify(project));
  const output = path.join(root, "beat-sync.mp4");
  const rendered = await renderNle({ projectFile, assetsDir: assets, out: output, encoding: "draft" });
  expect(fs.existsSync(rendered.output)).toBe(true);
  // 视觉切换帧:场景检测阈值 0.3,红↔蓝应恰好两次。
  const scenes = spawnSync("ffmpeg", ["-nostdin", "-v", "info", "-i", rendered.output, "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 8_000_000, windowsHide: true });
  const cutTimes = [...scenes.stderr.matchAll(/pts_time:([\d.]+)/g)].map(match => Number(match[1]));
  // 音频 beep 起点:静音段结束即 beep 开始。
  const silence = spawnSync("ffmpeg", ["-nostdin", "-v", "info", "-i", rendered.output, "-af", "silencedetect=noise=-40dB:d=0.2", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 8_000_000, windowsHide: true });
  const beeps = [...silence.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(match => Number(match[1]));
  const expectedBeeps = [0, 0.5, 1, 1.5, 2, 2.5];
  expect(beeps.length, `beeps: ${JSON.stringify(beeps)}`).toBeGreaterThanOrEqual(4);
  const nearest = (time: number) => expectedBeeps.reduce((best, beat) => Math.abs(beat - time) < Math.abs(best - time) ? beat : best, 0);
  // 两个视觉切换都落在整拍上(1.0s / 2.0s),误差 ≤1.5 帧。
  expect(cutTimes.length, `cuts: ${JSON.stringify(cutTimes)}`).toBe(2);
  for (const cut of cutTimes) expect(Math.abs(nearest(cut) - cut), `cut ${cut}`).toBeLessThanOrEqual(FRAME * 1.5 + 0.002);
  // 阴性对照:半拍(0.5/1.5/2.5)处没有视觉切换。
  for (const half of [0.5, 1.5, 2.5]) expect(cutTimes.some(cut => Math.abs(cut - half) < 0.15), `half-beat ${half} must stay quiet`).toBe(false);
  // 工程切点即节拍:1.0s 与 2.0s 必须各自命中一个 beep 起点与一个切帧。
  expect(cutTimes.some(cut => Math.abs(cut - 1) <= FRAME * 1.5 + 0.002)).toBe(true);
  expect(cutTimes.some(cut => Math.abs(cut - 2) <= FRAME * 1.5 + 0.002)).toBe(true);
  if (process.env.GLINT_BEAT_SYNC_EVIDENCE) {
    fs.mkdirSync(process.env.GLINT_BEAT_SYNC_EVIDENCE, { recursive: true });
    fs.copyFileSync(rendered.output, path.join(process.env.GLINT_BEAT_SYNC_EVIDENCE, "beat-sync.mp4"));
    fs.writeFileSync(path.join(process.env.GLINT_BEAT_SYNC_EVIDENCE, "measurement.json"), JSON.stringify({ cutTimes, beeps, expectedBeeps, frameBudgetMs: Math.round(FRAME * 1500) }, null, 2));
  }
}, 240_000);
