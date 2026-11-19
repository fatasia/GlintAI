import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no download */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("edits a brush stroke in the built editor and restores its geometry", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-brush-ui-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const project = parseProject({ schemaVersion: 1, id: "brush-ui", title: "Brush", aspect: "16:9", theme: "hand-note", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "颜色与笔触", narration: { text: "编辑笔触", durationMs: 2000 }, elements: [{ id: "paint", kind: "rect", x: .5, y: .65, w: .4, h: .15, fill: "#d24d2f" }] }] });
    await page.evaluateOnNewDocument(value => { if (!localStorage.getItem("glint.workspace")) localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project: value })); }, project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]'); await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('select[aria-label="色块形态"]', { visible: true });
    await page.select('select[aria-label="色块形态"]', "brush");
    await page.waitForSelector('[aria-label="对象 paint"] svg path');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.scenes?.[0]?.elements?.[0]?.appearance === "brush", { timeout: 15000 });
    const radiusDisabled = await page.$eval('input[aria-label="色块圆角"]', el => (el as HTMLInputElement).disabled); expect(radiusDisabled).toBe(true);
    if (process.env.GLINT_BRUSH_EVIDENCE) { await page.$eval('[aria-label="镜头画布"]', el => el.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_BRUSH_EVIDENCE, "desktop.png") }); }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await page.$eval('[aria-label="对象与关键帧"]', el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth })); expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    if (process.env.GLINT_BRUSH_EVIDENCE) { await page.$eval('[aria-label="对象与关键帧"]', el => el.scrollIntoView({ block: "start" })); await page.screenshot({ path: path.join(process.env.GLINT_BRUSH_EVIDENCE, "mobile.png") }); }
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click(); await page.waitForSelector('select[aria-label="色块形态"]', { visible: true });
    expect(await page.$eval('select[aria-label="色块形态"]', el => (el as HTMLSelectElement).value)).toBe("brush");
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);
