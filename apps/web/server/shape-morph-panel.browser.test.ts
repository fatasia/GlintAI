import { openInspector, openRestoredProject } from "./browser-workspace-helpers";
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
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("sets and removes a morph through the built scene editor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-morph-panel-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const sessions = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); });
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), sessionStore: sessions, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const line = { id: "line", kind: "path" as const, x: .5, y: .5, w: 1, h: 1, d: "M0 0 L80 80", viewBox: [100, 100] as [number, number], stroke: "#ff0000", strokeWidth: 4 };
    const project = parseProject({ schemaVersion: 1, id: "morph-ui", title: "Shape", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "title", title: "一", narration: { text: "一", durationMs: 2000 }, elements: [line] },
      { id: "two", kind: "title", title: "二", narration: { text: "二", durationMs: 2000 }, elements: [{ ...line, d: "M10 10 L90 90", stroke: "#0000ff" }] },
    ] });
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", project: value })), project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openRestoredProject(page);
    await page.locator('[aria-label="分镜时间线"] button:nth-child(2)').click();
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="矩形形变转场"]', { visible: true });
    expect(await page.$eval('[aria-label="矩形形变转场"]', element => element.textContent)).toContain("匹配对象：line");
    await page.locator('input[aria-label="形变时长"]').fill("1300");
    await page.locator('[aria-label="矩形形变转场"] button::-p-text(应用形变)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="矩形形变转场"] [role="alert"]')?.textContent?.includes("120 至 1200"));
    expect((sessions.snapshot("morph-ui").snapshot.document as typeof project).scenes[1]!.transition).toBeUndefined();
    await page.locator('input[aria-label="形变时长"]').fill("600");
    await page.locator('[aria-label="矩形形变转场"] button::-p-text(应用形变)').click();
    await page.waitForFunction(async () => (await (await fetch("/api/session/snapshot?projectId=morph-ui")).json()).snapshot?.document?.scenes?.[1]?.transition?.durationMs === 600, { timeout: 15000 });
    expect((sessions.snapshot("morph-ui").snapshot.document as typeof project).scenes[1]!.transition).toEqual({ in: "shape-morph", durationMs: 600 });
    const canvas = await page.waitForSelector('[aria-label="镜头画布"]', { visible: true });
    const pathData = () => page.$eval('[aria-label="镜头画布"] [aria-label="对象 line"] path', el => el.getAttribute("d"));
    expect(await pathData()).toBe("M0 0 L80 80");
    const slider = await page.$('input[aria-label="播放头"]');
    await slider!.focus(); await page.keyboard.press("Home");
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => (document.querySelector('input[aria-label="播放头"]') as HTMLInputElement)?.value === "300");
    expect(await pathData()).toBe("M5 5 L85 85");
    expect((sessions.snapshot("morph-ui").snapshot.document as typeof project).scenes[1]!.elements![0]).toMatchObject({ d: "M10 10 L90 90" });
    if (process.env.GLINT_MORPH_PANEL_EVIDENCE) { await canvas!.evaluate(el => el.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_MORPH_PANEL_EVIDENCE, "canvas-mid-desktop.png") }); }
    await page.keyboard.press("End"); expect(await pathData()).toBe("M10 10 L90 90");
    await page.locator('[aria-label="选中路径数据"]').fill("M20 20 L70 70");
    const width = await page.$('[aria-label="路径宽度"]');
    await width!.focus(); await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(item => item.textContent?.includes("草稿已保留")), { timeout: 8000 });
    expect(await page.$eval('[aria-label="选中路径数据"]', el => (el as HTMLTextAreaElement).value)).toBe("M20 20 L70 70");
    expect(await page.$eval('[aria-label="对象与关键帧"] button::-p-text(应用路径数据)', el => (el as HTMLButtonElement).disabled)).toBe(true);
    expect((sessions.snapshot("morph-ui").snapshot.document as typeof project).scenes[1]!.elements![0]).toMatchObject({ d: "M10 10 L90 90" });
    await page.locator('button::-p-text(放弃路径草稿)').click();
    expect(await page.$eval('[aria-label="选中路径数据"]', el => (el as HTMLTextAreaElement).value)).toBe("M10 10 L90 90");
    if (process.env.GLINT_MORPH_PANEL_EVIDENCE) { await page.$eval('[aria-label="矩形形变转场"]', el => el.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_MORPH_PANEL_EVIDENCE, "desktop.png") }); }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="矩形形变转场"]'); expect(await panel!.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (process.env.GLINT_MORPH_PANEL_EVIDENCE) { await panel!.evaluate(el => el.scrollIntoView({ block: "center" })); await page.screenshot({ path: path.join(process.env.GLINT_MORPH_PANEL_EVIDENCE, "mobile.png") }); }
    await page.locator('[aria-label="矩形形变转场"] button::-p-text(移除形变)').click();
    await page.waitForFunction(async () => !(await (await fetch("/api/session/snapshot?projectId=morph-ui")).json()).snapshot?.document?.scenes?.[1]?.transition, { timeout: 15000 });
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (!process.env.GLINT_PRESERVE_TEST_DATA) fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
