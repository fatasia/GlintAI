import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { makeBeatFixture } from "./beat-fixture";
// @ts-expect-error JavaScript server exercised via HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no downloads */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("analyzes a trimmed library audio clip and snaps another clip to the estimated onset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-ui-")), media = path.join(root, "media"); fs.mkdirSync(media); fs.writeFileSync(path.join(media, "clicks.wav"), makeBeatFixture());
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); opened = await openCaptureBrowser(1280, 900);
    const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "detected-beats", title: "拍点测试", fps: 30, width: 1280, height: 720, tracks: [
      { id: "t1", kind: "text", name: "字幕", clips: [{ id: "a", kind: "text", text: "卡点", startMs: 0, durationMs: 2000 }] },
      { id: "a1", kind: "audio", name: "音频", clips: [{ id: "music", kind: "audio", src: "assets/clicks.wav", startMs: 1000, durationMs: 4000, trimStartMs: 1000 }] },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]'); await page.locator('summary::-p-text(节拍吸附)').click();
    expect(await page.$eval('button::-p-text(分析选中音频)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[aria-label="音频 music"]').click();
    const response = page.waitForResponse(result => result.url().endsWith("/api/nle/beats"));
    await page.locator('button::-p-text(分析选中音频)').click();
    const value = await (await response).json(); expect(value.scope).toBe("estimated-energy-peaks"); expect(value.beatsMs.length).toBe(8);
    await page.waitForFunction(() => document.body.innerText.includes("峰值不一定是拍点"));
    expect(await page.$eval('[aria-label="节拍来源"]', element => (element as HTMLSelectElement).value)).toBe("manual");
    await page.select('[aria-label="节拍来源"]', "audio");
    await page.locator('input[aria-label="启用节拍吸附"]').click();
    const clip = await page.$('[aria-label="字幕 a"]'); if (!clip) throw new Error("text clip missing");
    const rect = await clip.boundingBox(); if (!rect) throw new Error("text clip bounds missing");
    const target = 1000 + value.beatsMs[0];
    await page.mouse.move(rect.x + 30, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 30 + (target + 20) * 0.08, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].startMs === expected, {}, target);
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].startMs === 0);
    await page.locator('[aria-label="音频 music"]').click();
    await page.locator('input[aria-label="起点 ms"]').fill("1500"); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForFunction(() => document.body.innerText.includes("没有可用的当前音频分析"));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.$eval('section[aria-label="剪辑台"]', element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const realRoot = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    if (path.dirname(realRoot) !== temp || !path.basename(realRoot).startsWith("glint-beat-ui-")) throw new Error("Unexpected temporary directory");
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
}, 60_000);
