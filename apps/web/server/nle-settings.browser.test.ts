import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised via the browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* No download. */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("changes 4K/fps from the NLE and undoes through the shared history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-settings-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]'); await page.locator('button::-p-text(+ 文字)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2") || "null")?.tracks?.find((track: { kind: string }) => track.kind === "text")?.clips?.length > 0);
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!));
    await page.locator('button::-p-text(项目规格)').click();
    await page.select('select[aria-label="画布分辨率"]', "3840"); await page.locator('input[aria-label="项目帧率"]').fill("24");
    if (process.env.GLINT_NLE_SETTINGS_EVIDENCE) await (await page.$('[aria-label="项目规格"][role="dialog"]'))!.screenshot({ path: path.join(process.env.GLINT_NLE_SETTINGS_EVIDENCE, "desktop.png") });
    await page.locator('button::-p-text(应用规格)').click();
    await page.waitForFunction(() => { const p = JSON.parse(localStorage.getItem("glint.nle.project.v2") || "null"); return p?.width === 3840 && p?.height === 2160 && p?.fps === 24; });
    const current = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!));
    expect(current.tracks.find((track: { kind: string }) => track.kind === "text").clips[0].fontSize).toBe((before.tracks.find((track: { kind: string }) => track.kind === "text").clips[0].fontSize ?? 64) * 2);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.nle-stage div')].some(el => el.style.width === "3840px" && el.style.height === "2160px"));
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => { const p = JSON.parse(localStorage.getItem("glint.nle.project.v2") || "null"); return p?.width === 1920 && p?.height === 1080 && p?.fps === 30; });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await page.locator('button::-p-text(项目规格)').click();
    const dialog = await page.$('[aria-label="项目规格"][role="dialog"]'); const box = await dialog!.boundingBox(); expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    if (process.env.GLINT_NLE_SETTINGS_EVIDENCE) await dialog!.screenshot({ path: path.join(process.env.GLINT_NLE_SETTINGS_EVIDENCE, "mobile.png") });
    await page.locator('[role="dialog"] button::-p-text(取消)').click();
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
