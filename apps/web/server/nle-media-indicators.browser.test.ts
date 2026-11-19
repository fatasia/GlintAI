import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised via a browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = true; try { findSystemBrowser(); execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { available = false; }

function wav(amplitude: number): Buffer {
  const rate = 8000, count = rate * 10, result = Buffer.alloc(44 + count * 2);
  result.write("RIFF", 0); result.writeUInt32LE(36 + count * 2, 4); result.write("WAVEfmt ", 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) result.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 440) * amplitude * 32767), 44 + i * 2);
  return result;
}

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("shows the trimmed source frame and actual per-track playback levels including mute and solo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-indicators-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  fs.writeFileSync(path.join(mediaDir, "loud.wav"), wav(0.5)); fs.writeFileSync(path.join(mediaDir, "quiet.wav"), wav(0.1));
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(mediaDir, "redblue.mp4")]);
  const project = { schemaVersion: 1, id: "indicators", title: "指标", fps: 20, width: 640, height: 360, tracks: [
    { id: "v1", kind: "video", name: "主画面", clips: [{ id: "shot", kind: "video", src: "assets/redblue.mp4", startMs: 0, durationMs: 1000, trimStartMs: 1000, volume: 0 }] },
    { id: "a1", kind: "audio", name: "声音一", clips: [{ id: "loud", kind: "audio", src: "assets/loud.wav", startMs: 0, durationMs: 9000 }] },
    { id: "a2", kind: "audio", name: "声音二", clips: [{ id: "quiet", kind: "audio", src: "assets/quiet.wav", startMs: 0, durationMs: 9000 }] },
  ] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(mediaDir, {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); opened = await openCaptureBrowser(1440, 960); const page = opened.page; page.setDefaultTimeout(8000);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]');
    const selector = '[aria-label="多轨时间线"] [aria-label="主画面 shot"] canvas[data-source-time]';
    await page.waitForFunction(sel => {
      const canvas = document.querySelector<HTMLCanvasElement>(sel); if (!canvas || Number(canvas.dataset.sourceTime) < 0.95) return false;
      try { const pixels = canvas.getContext("2d")!.getImageData(64, 36, 1, 1).data; return pixels[2]! > pixels[0]! * 2; } catch { return false; }
    }, { timeout: 20000 }, selector);
    expect(await page.$eval(selector, element => Number((element as HTMLElement).dataset.sourceTime))).toBeGreaterThanOrEqual(0.95);
    await page.locator('button[aria-label="播放"]').click();
    await page.waitForFunction(() => {
      const a = Number(document.querySelector('[aria-label="声音一 预览电平"]')?.getAttribute("aria-valuenow"));
      const b = Number(document.querySelector('[aria-label="声音二 预览电平"]')?.getAttribute("aria-valuenow"));
      return a > -35 && b > -45 && a > b + 6;
    }, { timeout: 10000 });
    await page.locator('button[aria-label="声音一 静音"]').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="声音一 静音"]')?.getAttribute("aria-pressed") === "true" && Number(document.querySelector('[aria-label="声音一 预览电平"]')?.getAttribute("aria-valuenow")) === -60 && Number(document.querySelector('[aria-label="声音二 预览电平"]')?.getAttribute("aria-valuenow")) > -45, { timeout: 5000 });
    await page.locator('button[aria-label="声音一 静音"]').click(); await page.locator('button[aria-label="声音一 独听"]').click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="声音二 预览电平"]')?.getAttribute("aria-valuenow")) === -60 && Number(document.querySelector('[aria-label="声音一 预览电平"]')?.getAttribute("aria-valuenow")) > -35, { timeout: 5000 });
    if (process.env.GLINT_NLE_INDICATORS_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_NLE_INDICATORS_EVIDENCE, "timeline.png") });
    await page.locator('button[aria-label="暂停"]').click();
    const clipSelector = '[aria-label="主画面 shot"]';
    const clip = await page.$(clipSelector); const rect = await clip!.boundingBox(); if (!rect) throw new Error("视频片段不可见");
    // Start on empty lane, then drag across the clip to select it.
    await page.mouse.move(rect.x + rect.width + 25, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + 8, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute("aria-pressed") === "true", { timeout: 5000 }, clipSelector);
    // A real pointer drag on the clip must still move it.
    const oldLeft = await page.$eval(clipSelector, e => parseFloat((e as HTMLElement).style.left));
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 35, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
    expect(await page.$eval(clipSelector, e => parseFloat((e as HTMLElement).style.left))).toBeGreaterThan(oldLeft);
    const remove = await page.$('button[aria-label="删除 声音二"]'); if (!remove) throw new Error("删除按钮缺失");
    await remove.evaluate(e => e.scrollIntoView({ block: "center", inline: "nearest" }));
    const removeRect = await remove.boundingBox(); if (!removeRect) throw new Error("删除按钮不可见");
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), { x: removeRect.x + removeRect.width / 2, y: removeRect.y + removeRect.height / 2 });
    expect(hit).toBe("删除 声音二");
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.mouse.click(removeRect.x + removeRect.width / 2, removeRect.y + removeRect.height / 2);
    await page.waitForFunction(() => !document.querySelector('[aria-label="声音二 预览电平"]') && ![...document.querySelectorAll('audio')].some(a => a.currentSrc.includes('quiet.wav')), { timeout: 5000 });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.$('[aria-label="多轨时间线"]')).toBeTruthy();
    await page.$eval('[aria-label="多轨时间线"]', e => e.scrollIntoView({ block: "end" }));
    if (process.env.GLINT_NLE_INDICATORS_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_NLE_INDICATORS_EVIDENCE, "timeline-mobile.png") });
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
