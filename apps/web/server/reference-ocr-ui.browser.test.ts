import { openHomeTool } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("shows local OCR failure without losing the reference project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ocr-ui-")), media = path.join(root, "media"); fs.mkdirSync(media); fs.writeFileSync(path.join(media, "sample.mp4"), "fixture");
  let input: { ocr?: boolean } | undefined;
  const project = { schemaVersion: 1, id: "reference-ocr", title: "参考片", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "ref-shot-001", kind: "image", src: "assets/one.jpg", narration: { text: "原旁白", durationMs: 1000 } },
  ] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}),
    referenceBuilder: async (value: { ocr?: boolean }) => { input = value; return { project, shots: 1, ocr: { status: "failed", samples: [] } }; } }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900); const page = browser.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "reference"); await page.locator('summary::-p-text(参考片 → 可审阅工程)').click();
    await page.waitForSelector('select[aria-label="选择参考片"] option');
    const checks = await page.$$('[aria-label="从参考片重建工程"] input[type="checkbox"]');
    expect(await checks[1]!.evaluate(element => (element as HTMLInputElement).checked)).toBe(false);
    await checks[0]!.click(); await checks[1]!.click(); await page.locator('button::-p-text(分析并生成工程)').click();
    await page.waitForSelector('[aria-label="参考画面文字识别"]'); expect(input?.ocr).toBe(true);
    await page.locator('summary::-p-text(画面文字识别)').click();
    const text = await page.$eval('[aria-label="参考画面文字识别"]', element => element.textContent);
    expect(text).toContain("本机 OCR 未完成"); expect(text).toContain("参考工程仍可编辑"); expect(text).toContain("非逐字时间码");
    await page.waitForSelector('[aria-label="共享工程编辑"]'); expect(await page.$eval('[aria-label="共享工程编辑"]', element => element.textContent)).toContain("原旁白");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="参考画面文字识别"]'); expect(await panel!.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  } finally { await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
