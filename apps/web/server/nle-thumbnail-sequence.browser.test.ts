import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = true; try { findSystemBrowser(); execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { available = false; }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("samples multiple source frames through the real timeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-thumbnail-sequence-")), media = path.join(root, "media"); fs.mkdirSync(media);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(media, "redblue.mp4")]);
  const project = { schemaVersion: 1, id: "thumb-sequence", title: "缩略图", fps: 20, width: 640, height: 360, tracks: [
    { id: "v1", kind: "video", name: "画面", clips: [{ id: "shot", kind: "video", src: "assets/redblue.mp4", startMs: 0, durationMs: 2000, volume: 0 }] },
  ] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]');
    const selector = '[aria-label="画面 shot"] canvas[data-nle-thumbnail]';
    await page.waitForFunction(sel => { const canvases = [...document.querySelectorAll<HTMLCanvasElement>(sel)]; return canvases.length === 3 && canvases.every(canvas => canvas.dataset.sourceTime !== undefined); }, { timeout: 20000 }, selector);
    const frames = await page.$$eval(selector, canvases => canvases.map(canvas => { const data = (canvas as HTMLCanvasElement).getContext("2d")!.getImageData(64, 36, 1, 1).data; return { time: Number((canvas as HTMLElement).dataset.sourceTime), red: data[0]!, blue: data[2]! }; }));
    expect(frames[0]!.time).toBeCloseTo(0); expect(frames[0]!.red).toBeGreaterThan(frames[0]!.blue * 2);
    expect(frames[2]!.time).toBeGreaterThan(1); expect(frames[2]!.blue).toBeGreaterThan(frames[2]!.red * 2);
    expect(await page.$('[aria-label="画面 shot"] video')).toBeNull();
    if (process.env.GLINT_THUMB_SEQUENCE_EVIDENCE) { await page.$eval('[aria-label="多轨时间线"]', el => el.scrollIntoView({ block: "end" })); await page.screenshot({ path: path.join(process.env.GLINT_THUMB_SEQUENCE_EVIDENCE, "desktop.png") }); }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.$eval('[aria-label="多轨时间线"]', el => el.scrollIntoView({ block: "end" }));
    expect(await page.$('[aria-label="多轨时间线"]')).toBeTruthy();
    if (process.env.GLINT_THUMB_SEQUENCE_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_THUMB_SEQUENCE_EVIDENCE, "mobile.png") });
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
