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

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("tool navigation keeps advanced features reachable on desktop and mobile", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build glint-web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-tool-navigation-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page;
    const requested: string[] = [];
    page.on("request", request => requested.push(request.url()));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    // The current shell groups tools in persistent project/assets/automation workspaces.
    await page.locator('.rail-button::-p-text(素材)').click();
    await page.waitForSelector('[aria-label="本地 AI 超分"]', { visible: true });
    expect(await page.$eval('[aria-label="本地 AI 超分"]', element => element.textContent)).toContain("未配置运行程序和模型");
    expect(requested.some(url => /\/(?:BatchWorkshop|SkillCatalog|ModelSettings)-[^/]+\.js/.test(url))).toBe(false);
    await page.locator('#tool-tab-examples').click();
    await page.waitForSelector('#tool-panel-examples:not([hidden])');
    await page.waitForFunction(() => document.querySelector("#tool-panel-examples")?.textContent?.includes("预览示例"));
    expect(await page.$eval('#tool-panel-examples', element => element.textContent)).toContain("预览示例");
    expect(await page.$$eval(".rail-button", elements => elements.map(element => element.textContent?.trim()))).toEqual(["搜索", "项目", "素材", "自动化", "剪辑台", "帮助", "设置"]);
    expect(await page.$eval('#tool-tab-examples', element => element.getAttribute("aria-selected"))).toBe("true");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.rail-button::-p-text(自动化)').click();
    await page.locator('#tool-tab-batch').click();
    await page.waitForSelector('#tool-panel-batch:not([hidden]) [aria-label="批量混剪"]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#tool-tab-canvas').click();
    expect(await page.$eval('#tool-panel-canvas', element => element.hasAttribute("hidden"))).toBe(false);
    await page.locator('[aria-label="生成画布"] button::-p-text(＋ 文本)').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="画布区域"] strong')].some(element => element.textContent?.startsWith("文本 ·")));
    await page.evaluate(() => {
      const title = [...document.querySelectorAll('[aria-label="画布区域"] strong')].find(element => element.textContent?.startsWith("文本 ·"));
      (title?.parentElement?.parentElement as HTMLElement).click();
    });
    await page.waitForSelector('[aria-label="节点提示词"]');
    await page.locator('[aria-label="节点提示词"]').fill("保留这段文本");
    await page.locator('.rail-button::-p-text(素材)').click();
    await page.locator('.rail-button::-p-text(自动化)').click();
    expect(await page.$eval<HTMLTextAreaElement>('[aria-label="节点提示词"]', element => element.value)).toBe("保留这段文本");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The project links moved from a page footer into the rail's help popover.
    await page.locator('.rail-button[aria-label="帮助"]').click();
    await page.waitForSelector('[aria-label="项目链接"] a', { visible: true });
    const links = await page.$$eval('[aria-label="项目链接"] a', elements => elements.map(element => element.textContent?.trim()));
    expect(links).toEqual(["使用文档", "源代码", "下载桌面客户端"]);
    const screenshots = process.env.GLINT_UI_SCREENSHOTS_DIR;
    if (screenshots) { fs.mkdirSync(screenshots, { recursive: true }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(screenshots, "home-mobile.png") }); }
    await page.locator('[aria-label="项目链接"] a::-p-text(使用文档)').click();
    await page.waitForSelector('.docs-page');
    expect(await page.$eval('.app-shell', element => element.hasAttribute("hidden"))).toBe(true);
    await page.locator('[aria-label="文档目录"] a::-p-text(客户端下载)').click();
    expect(await page.evaluate(() => location.hash)).toBe("#/docs/install");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (screenshots) {
      await page.screenshot({ path: path.join(screenshots, "docs-mobile.png") });
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#/docs`, { waitUntil: "networkidle0" });
      await page.waitForSelector('.docs-page');
      await page.screenshot({ path: path.join(screenshots, "docs-desktop.png") });
    }
  } finally {
    await opened?.browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("home and docs link to the configured downloadable client", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-client-ui-"));
  const archive = path.join(root, "Glint.zip"); fs.writeFileSync(archive, Buffer.from([80, 75, 3, 4, 1, 2, 3]));
  const previous = process.env.GLINT_DESKTOP_DOWNLOAD_FILE; process.env.GLINT_DESKTOP_DOWNLOAD_FILE = archive;
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.locator('.rail-button[aria-label="帮助"]').click();
    await page.waitForSelector('[aria-label="项目链接"] a[href="/api/download/client"]', { visible: true });
    await page.locator('[aria-label="项目链接"] a::-p-text(使用文档)').click();
    await page.waitForSelector('.docs-page a[href="/api/download/client"]');
    expect(await page.$eval('.docs-page a[href="/api/download/client"]', element => element.textContent)).toContain("下载 Windows 精简包");
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_DESKTOP_DOWNLOAD_FILE; else process.env.GLINT_DESKTOP_DOWNLOAD_FILE = previous;
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
