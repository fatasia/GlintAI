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
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("previews actual theme samples in desktop and mobile without editing the project", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-style-sample-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const project = parseProject({ schemaVersion: 1, id: "style-sample-ui", title: "Style", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "原有工程", narration: { text: "原有旁白", durationMs: 2000 } }] });
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project: value })), project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="风格包"] summary'); await page.$eval('[aria-label="风格包"] summary', element => (element as HTMLElement).click());
    await page.locator('[aria-label="风格详情"] button::-p-text(查看风格样片)').click();
    await page.waitForFunction(() => !!document.querySelector('[aria-label="风格样片"] [style*="--glint-color-bg"]'), { timeout: 20000 });
    const color = () => page.$eval('[aria-label="风格样片"] [style*="--glint-color-bg"]', element => (element as HTMLElement).style.getPropertyValue("--glint-color-bg"));
    const initialColor = await color();
    await page.locator('[aria-label="可选风格包"] button::-p-text(海报大字)').click();
    await page.waitForFunction(before => { const element = document.querySelector<HTMLElement>('[aria-label="风格样片"] [style*="--glint-color-bg"]'); return !!element && element.style.getPropertyValue("--glint-color-bg") !== before; }, {}, initialColor);
    expect(await color()).not.toBe(initialColor);
    await page.locator('[aria-label="风格样片"] button[aria-label="Play video"]').click();
    await page.waitForFunction(() => /0:0[12]\s*\/\s*0:03/.test(document.querySelector('[aria-label="风格样片"]')?.textContent ?? ""), { timeout: 5000 });
    await page.locator('[aria-label="风格样片"] button[aria-label="Pause video"]').click();
    const position = () => page.$eval('[aria-label="风格样片"]', el => el.textContent?.match(/0:0[0-3]\s*\/\s*0:03/)?.[0]);
    const pausedAt = await position();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await position()).toBe(pausedAt);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") || "null").project.theme)).toBe("glint-dark");
    if (process.env.GLINT_STYLE_SAMPLE_EVIDENCE) { await page.$eval('[aria-label="风格样片"]', e => e.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_STYLE_SAMPLE_EVIDENCE, "desktop.png") }); }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await page.$eval('[aria-label="风格详情"]', element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    if (process.env.GLINT_STYLE_SAMPLE_EVIDENCE) { await page.$eval('[aria-label="风格样片"]', e => e.scrollIntoView({ block: "start" })); await page.screenshot({ path: path.join(process.env.GLINT_STYLE_SAMPLE_EVIDENCE, "mobile.png") }); }
    await page.locator('[aria-label="风格详情"] button::-p-text(关闭样片)').click();
    expect(await page.$('[aria-label="风格样片"]')).toBeNull(); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);
