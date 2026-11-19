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

let available = false; try { findSystemBrowser(); available = true; } catch { /* no downloads */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_STROKE_E2E !== "1" || !available)("draws a real custom stroke, edits its timing, restores it and preserves undo on mobile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-stroke-ui-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = [], requested: string[] = []; page.on("pageerror", error => errors.push(String(error))); page.on("request", request => requested.push(request.url()));
    const project = parseProject({ schemaVersion: 1, id: "stroke-ui", title: "一笔成形", aspect: "16:9", theme: "hand-note", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "从想法到画面", narration: { text: "从想法到画面", durationMs: 3000 } }] });
    await page.evaluateOnNewDocument(value => { if (!localStorage.getItem("glint.workspace")) localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "路径验收", project: value })); }, project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    expect(requested.some(url => /\/ShotCanvas-[^/]+\.js/.test(url))).toBe(false);
    expect(requested.some(url => /\/ChaptersPanel-[^/]+\.js/.test(url))).toBe(false);
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('summary::-p-text(手绘与逐笔动画)').click();
    const pad = await page.waitForSelector('[aria-label="手绘输入画布"]', { visible: true }); await pad!.scrollIntoView(); const bounds = await pad!.boundingBox(); if (!bounds) throw new Error("No pen canvas");
    await page.mouse.move(bounds.x + bounds.width * 0.15, bounds.y + bounds.height * 0.7); await page.mouse.down();
    for (const [x, y] of [[.3, .4], [.5, .3], [.7, .5], [.85, .35]]) await page.mouse.move(bounds.x + bounds.width * x!, bounds.y + bounds.height * y!, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => (document.querySelector('[aria-label="新路径数据"]') as HTMLTextAreaElement)?.value.includes("L"));
    await page.locator('button::-p-text(加入镜头)').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="对象与关键帧"] button')].some(element => /^stroke-/.test(element.textContent ?? "")));
    await page.evaluate(() => { const element = [...document.querySelectorAll('[aria-label="对象与关键帧"] button')].find(element => /^stroke-/.test(element.textContent ?? "")); (element as HTMLElement).click(); });
    await page.waitForSelector('[aria-label="路径起笔时间"]');
    await page.locator('[aria-label="路径起笔时间"]').fill("300"); await page.locator('[aria-label="路径绘制时长"]').fill("1200");
    await page.locator('[aria-label="选中路径数据"]').fill("M180 720 Q600 180 980 580 C1200 850 1430 260 1740 420");
    await page.locator('button::-p-text(应用路径数据)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.scenes?.[0]?.elements?.[0]?.d?.includes("Q600"));
    await page.locator('button[aria-label="撤销"]').filter(button => button.textContent === "撤销").click();
    await page.waitForFunction(() => !(document.querySelector('[aria-label="选中路径数据"]') as HTMLTextAreaElement)?.value.includes("Q600"));
    await page.locator('button[aria-label="重做"]').filter(button => button.textContent === "重做").click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="选中路径数据"]') as HTMLTextAreaElement)?.value.includes("Q600"));
    if (process.env.GLINT_STROKE_EVIDENCE) {
      await page.$eval('[aria-label="播放头"]', el => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "900"); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => !!document.querySelector('[aria-label="镜头画布"] path')?.getAttribute("d"));
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.GLINT_STROKE_EVIDENCE) { await page.$eval('[aria-label="路径起笔时间"]', el => el.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_STROKE_EVIDENCE, "editor-mobile.png") }); }
    await page.waitForFunction(() => { const element = JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.scenes?.[0]?.elements?.[0]; return element?.d?.includes("Q600") && element?.drawStartMs === 300 && element?.drawDurationMs === 1200; });
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="路径绘制时长"]');
    expect(await page.$eval('[aria-label="路径起笔时间"]', el => (el as HTMLInputElement).value)).toBe("300");
    expect(await page.$eval('[aria-label="路径绘制时长"]', el => (el as HTMLInputElement).value)).toBe("1200");
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
