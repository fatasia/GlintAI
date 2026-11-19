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

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("one input opens an editable project; only export renders the real MP4", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  // The job runner spawns the studio CLI from GLINT_STUDIO_DIR; isolation only materialises it on demand.
  if (!fs.existsSync(path.join(process.env.GLINT_STUDIO_DIR ?? "", "scripts", "glint.ts"))) throw new Error("Set GLINT_TEST_REAL_STUDIO=1 so the job runner has a real studio copy");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-home-flow-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [], makeRequests: string[] = [];
    const evidence = process.env.GLINT_EVIDENCE_DIR ?? root; fs.mkdirSync(evidence, { recursive: true });
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/make" && request.method() === "POST") makeRequests.push(request.postData() ?? ""); });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
    await page.waitForSelector('.pc-box textarea', { visible: true });
    await page.screenshot({ path: path.join(evidence, "flow-home-desktop.png"), fullPage: true });
    // R37 home: the three modes are aria-pressed buttons, not role=tab.
    await page.locator('[aria-label="创作类型"] button::-p-text(图片生成)').click();
    await page.waitForSelector('textarea[aria-label="图片描述"]', { timeout: 15_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-home-image-tab.png") });
    await page.locator('[aria-label="创作类型"] button::-p-text(GIF 导出)').click();
    await page.waitForSelector('[aria-label="导出 GIF"]', { timeout: 15_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-home-gif-tab.png") });
    await page.locator('[aria-label="创作类型"] button::-p-text(视频创作)').click();
    await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
    await page.locator('textarea[aria-label="快速成片资料"]').fill("# 熵与咖啡\n\n- 热咖啡会放凉，热量自发从高温流向低温\n- 熵是微观排列方式的数量\n- 孤立系统的熵只增不减\n\n一杯咖啡，就是熵增的日常证据。");
    await page.locator('.pc-submit').click();
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"]')), { timeout: 30_000 });
    await page.waitForSelector('.glint-editor', { visible: true });
    expect(makeRequests).toEqual([]);
    const created = await page.evaluate(() => JSON.parse(localStorage.getItem('glint.projects') ?? '[]')[0]);
    expect(created.project.id).toMatch(/^editor-[a-f0-9]{16}$/);
    expect(created.text).toContain("熵与咖啡");
    expect(await page.$eval('.timeline-operations', node => (node as HTMLDetailsElement).open)).toBe(false);
    const bounds = await page.$eval('.glint-editor-stage', node => node.getBoundingClientRect().height);
    expect(bounds).toBeGreaterThan(300);
    await page.locator('button::-p-text(属性)').click();
    await page.waitForSelector('textarea[aria-label="title"]', { visible: true });
    await page.locator('textarea[aria-label="title"]').fill("用户修改后的开场标题");
    await page.locator('.workspace-toolbar button::-p-text(保存项目)').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('glint.projects') ?? '[]')[0].project.scenes[0].title)).toBe("用户修改后的开场标题");
    await page.locator('button::-p-text(返回画布)').click();
    await page.screenshot({ path: path.join(evidence, "flow-editor-desktop.png"), fullPage: true });
    await page.locator('.workspace-toolbar button::-p-text(导出视频)').click();
    await page.waitForSelector('#workspace-tools section[aria-label="配音与导出"]', { visible: true });
    expect(await page.$$('[aria-label="创作选项分类"]')).toHaveLength(0);
    await page.locator('#workspace-tools button::-p-text(导出 MP4)').click();
    await page.waitForSelector('video[aria-label="生成的视频"]', { visible: true, timeout: 90_000 });
    expect(makeRequests).toHaveLength(1);
    expect(JSON.parse(makeRequests[0]!).project.scenes[0].title).toBe("用户修改后的开场标题");
    const video = await page.$eval('video[aria-label="生成的视频"]', element => element.getAttribute("src"));
    expect(video).toMatch(/^\/api\/video\/idea-/);
    const download = await fetch(new URL(video! + '?download=1', url)); expect(download.ok).toBe(true); expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
    await page.locator('.workspace-tools-heading button::-p-text(关闭)').click();
    await page.locator('.workspace-toolbar button::-p-text(返回作品)').click();
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, "flow-home-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('.home-project', { visible: true });
    await page.locator('.home-project').click();
    await page.waitForSelector('.glint-editor', { visible: true });
    expect(await page.$eval('.workspace-title', node => node.textContent)).toContain("熵与咖啡");
  } finally {
    await opened?.browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
