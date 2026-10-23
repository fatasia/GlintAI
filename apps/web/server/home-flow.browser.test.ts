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

const dist = fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("one box on the home screen becomes a draft video and an editable project", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-home-flow-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.locator('[role="tab"]::-p-text(图片)').click();
    await page.waitForSelector('textarea[aria-label="图片描述"]', { timeout: 15_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-home-image-tab.png") });
    await page.locator('[role="tab"]::-p-text(GIF)').click();
    await page.waitForSelector('[aria-label="导出 GIF"]', { timeout: 15_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-home-gif-tab.png") });
    await page.locator('[role="tab"]::-p-text(视频)').click();
    await page.locator('textarea[aria-label="快速成片资料"]').fill("# 熵与咖啡\n\n- 热咖啡会放凉，热量自发从高温流向低温\n- 熵是微观排列方式的数量\n- 孤立系统的熵只增不减\n\n一杯咖啡，就是熵增的日常证据。");
    await page.locator('button::-p-text(生成草稿（免费）)').click();
    await page.waitForFunction(() => Boolean(document.querySelector('video[aria-label="快速成片结果"]')), { timeout: 60_000 });
    const video = await page.$eval('video[aria-label="快速成片结果"]', element => element.getAttribute("src"));
    expect(video).toMatch(/^\/api\/video\/idea-/);
    await page.locator('button::-p-text(继续编辑这支视频)').click();
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"]')), { timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(root, "home-flow.png") });
  } finally {
    await opened?.browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
