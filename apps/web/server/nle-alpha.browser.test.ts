import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised through a browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* No download. */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("selects transparent WebM from the NLE and labels its download correctly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-alpha-ui-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
  let alphaSeen: boolean | undefined;
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(media, {}), nleVideoRenderer: async ({ alpha }: { alpha: boolean }) => { alphaSeen = alpha; return { file: "fixture.webm", url: "/fixture.webm", bytes: 500 }; } }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]');
    await page.locator('button::-p-text(+ 文字)').click();
    await page.locator('.nle-menu-wrap > summary::-p-text(导出)').click();
    await page.locator('button::-p-text(透明 WebM)').click();
    await page.waitForFunction(() => document.body.textContent?.includes("下载 透明 WebM"));
    expect(alphaSeen).toBe(true); expect(await page.$eval('[aria-label="交付下载"]', el => el.textContent)).toContain("下载成片 WebM");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    alphaSeen = undefined;
    await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/nle/render") && response.request().method() === "POST"), page.locator('button::-p-text(透明 WebM)').click()]);
    await page.waitForFunction(() => document.body.textContent?.includes("下载 透明 WebM"));
    expect(alphaSeen).toBe(true);
    if (process.env.GLINT_ALPHA_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_ALPHA_EVIDENCE, "ui-mobile.png") });
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
