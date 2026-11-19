import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openRestoredProject } from "./browser-workspace-helpers";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false; try { findSystemBrowser(); browserAvailable = true; } catch { /* no browser download */ }
const SCRIPT = "第一场 茶馆 内 日\n老陈擦拭柜台，门外风铃响。\n小满推门进来，抖落肩上的雪。\n小满：陈叔，今年的新茶到了吗？\n老陈：到了，就等你来尝。\n第二场 街道 外 夜\n雨中，小满快步走。\n小满：这雨，怕是要下一整夜。";

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("splits a screenplay into a storyboard where MG and AIGC are equal choices", async () => {
  const root = process.env.GLINT_DATA_DIR;
  if (!root || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_CACHE_DIR) throw new Error("Explicit isolated data directories are required");
  const evidence = process.env.GLINT_STORYBOARD_EVIDENCE ?? root;
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path.join(root, "media", "board.mp4")], { windowsHide: true });
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer({ distDir: dist, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1440, 900);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.locator('[aria-label="创作类型"] button::-p-text(视频创作)').click();
    await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
    await page.locator('textarea[aria-label="快速成片资料"]').fill("# 茶馆\n\n- 老陈开门迎客\n- 小满带来新茶\n- 雨夜归家\n\n一间茶馆，三个夜晚。");
    await page.locator('.pc-submit').click();
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"]')), { timeout: 30_000 });
    await openRestoredProject(page);
    await page.locator('.glint-view-switch button::-p-text(脚本)').click();
    await page.locator('.script-editor button::-p-text(新建)').click();
    await page.select('[aria-label="新文档类型"]', "screenplay");
    await page.$eval('[aria-label="文档名称"]', (element, name) => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(element, name); element.dispatchEvent(new Event("input", { bubbles: true })); }, "茶馆剧本");
    await page.$eval("form", form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await page.waitForSelector('[aria-label="脚本文档正文"]', { visible: true });
    await page.$eval('[aria-label="脚本文档正文"]', (element, text) => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(element, text); element.dispatchEvent(new Event("input", { bubbles: true })); }, SCRIPT);

    await page.locator('.glint-view-switch button::-p-text(分镜)').click();
    await page.waitForSelector('[aria-label="默认渲染方式"]', { visible: true });
    await page.screenshot({ path: path.join(evidence, "storyboard-choice.png") });

    await page.locator('[aria-label="默认渲染方式"] button::-p-text(MG 动态图形)').click();
    await page.waitForSelector('.storyboard-table tbody tr', { visible: true });
    const rows = await page.$$eval('.storyboard-table tbody tr:not(.storyboard-scene)', list => list.length);
    expect(rows).toBeGreaterThan(4);
    await page.locator('.storyboard-table tbody tr:not(.storyboard-scene) button::-p-text(AIGC)').click();
    await page.screenshot({ path: path.join(evidence, "storyboard-table.png") });

    const layout = await page.evaluate(() => {
      const pane = document.querySelector(".storyboard")!.getBoundingClientRect(), top = document.querySelector(".glint-editor-top")!.getBoundingClientRect(), side = document.querySelector(".storyboard-side")!.getBoundingClientRect();
      const wrap = document.querySelector(".storyboard-table-wrap") as HTMLElement;
      return { paneTop: pane.top, topBottom: top.bottom, paneBottom: pane.bottom, vh: innerHeight, sideRight: side.right, vw: innerWidth, hScroll: wrap.scrollWidth > wrap.clientWidth + 1 };
    });
    expect(Math.abs(layout.paneTop - layout.topBottom)).toBeLessThan(2);
    expect(layout.paneBottom).toBeLessThanOrEqual(layout.vh + 1);
    expect(layout.sideRight).toBeLessThanOrEqual(layout.vw + 1);
    expect(layout.hScroll).toBe(false);

    const beforeBinding = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project);
    await page.locator('[aria-label="应用分镜"] button::-p-text(生成镜头视频)').click();
    await page.waitForSelector('[aria-label="素材描述"]');
    expect(await page.$eval('[aria-label="素材描述"]', element => (element as HTMLTextAreaElement).value)).not.toBe("");
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.$eval('[aria-label="素材工坊"]', element => element.scrollIntoView({ block: "start" }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.$eval('[aria-label="素材描述"]', element => element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(evidence, `storyboard-generator-${width}.png`) });
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.locator('[aria-label="从素材库视频开始"] button::-p-text(board.mp4)').click();
    expect(await page.$eval('[aria-label="应用分镜"] select', element => (element as HTMLSelectElement).value)).toBe("board.mp4");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project)).toEqual(beforeBinding);
    page.once("dialog", dialog => void dialog.accept());
    await page.locator('[aria-label="应用分镜"] button::-p-text(应用本集到工程)').click();
    await page.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.length === count, {}, rows);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0])).toMatchObject({ kind: "video", src: "assets/board.mp4" });
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.glint-editor button[aria-label="撤销"]')?.disabled === false);
    await page.$eval('.glint-editor button[aria-label="撤销"]', element => element.scrollIntoView({ block: "center" }));
    await page.locator('.glint-editor button[aria-label="撤销"]').click();
    await page.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.length !== count, {}, rows);
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.glint-editor button[aria-label="重做"]')?.disabled === false);
    await page.locator('.glint-editor button[aria-label="重做"]').click();
    await page.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.length === count, {}, rows);
    await page.setViewport({ width: 1024, height: 900, deviceScaleFactor: 1 });
    await page.screenshot({ path: path.join(evidence, "storyboard-1024.png") });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.screenshot({ path: path.join(evidence, "storyboard-390.png") });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.locator('.glint-view-switch button::-p-text(作品)').click();
    await page.waitForSelector(".storyboard", { hidden: true });
    const applied = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project);
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("glint.storyboard.v1:")) localStorage.removeItem(key); });
    await page.reload({ waitUntil: "networkidle0" }); await openRestoredProject(page);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project)).toEqual(applied);
    await page.locator('.glint-view-switch button::-p-text(分镜)').click();
    await page.waitForSelector('.storyboard-table tbody tr', { visible: true });
    expect(await page.$$eval('.storyboard-table tbody tr:not(.storyboard-scene)', list => list.length)).toBe(rows);
    expect(await page.$eval('[aria-label="应用分镜"] select', element => (element as HTMLSelectElement).value)).toBe("board.mp4");
    expect(await page.$('[aria-label="默认渲染方式"]')).toBeNull();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project)).toEqual(applied);
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 240000);
