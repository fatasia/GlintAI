import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised through a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("generation canvas drags, undoes and restores layout without submitting media", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-generation-surface-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 1000); const page = opened.page;
    const errors: string[] = [], submissions: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { if (request.url().includes("/api/media/submit")) submissions.push(request.url()); });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.locator('.rail-button::-p-text(自动化)').click();
    await page.locator('[aria-label="生成画布"] button::-p-text(＋ 文本)').click();
    await page.waitForSelector('.react-flow__node[data-id="text-1"]', { visible: true });
    const read = () => page.evaluate(() => JSON.parse(localStorage.getItem("glint:gen-canvas:layout:v1") ?? "{}"));
    const bounds = await page.$eval('.react-flow__node[data-id="text-1"] strong', element => { const r=element.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; });
    await page.mouse.move(bounds.x, bounds.y); await page.mouse.down(); await page.mouse.move(bounds.x+120, bounds.y+80, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem("glint:gen-canvas:layout:v1") ?? "{}")["text-1"]));
    const moved = await read();
    await page.locator('button::-p-text(撤销布局)').click(); expect(await read()).toEqual({});
    await page.locator('button::-p-text(重做布局)').click(); expect(await read()).toEqual(moved);
    await page.click('.react-flow__controls-zoomin');
    await page.waitForFunction(() => localStorage.getItem("glint:gen-canvas:viewport:v1") !== null);
    const viewport = await page.evaluate(() => localStorage.getItem("glint:gen-canvas:viewport:v1"));
    await page.reload({ waitUntil: "networkidle0" });
    await page.locator('.rail-button::-p-text(自动化)').click();
    await page.waitForSelector('.react-flow__node[data-id="text-1"]'); expect(await read()).toEqual(moved);
    expect(await page.evaluate(() => localStorage.getItem("glint:gen-canvas:viewport:v1"))).toBe(viewport);
    const zoom = JSON.parse(viewport!).zoom;
    await page.waitForFunction((expected: number) => {
      const element = document.querySelector('.generation-surface .react-flow__viewport');
      return element && Math.abs(new DOMMatrix(getComputedStyle(element).transform).a - expected) < 0.001;
    }, {}, zoom);
    await page.setViewport({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const evidence=process.env.GLINT_UI_SCREENSHOTS_DIR;
    if(evidence) { fs.mkdirSync(evidence,{recursive:true}); await page.setViewport({width:1280,height:1000}); await page.screenshot({path:path.join(evidence,"generation-canvas.png"),fullPage:true}); }
    expect(submissions).toEqual([]); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root,{recursive:true,force:true}); }
}, 60_000);
