import { openHomeTool } from "./browser-workspace-helpers";
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
import { createWorkbook } from "./workbook-fixture";

let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("previews a local source, then applies it at desktop and mobile widths", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build glint-web first");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-source-import-")), mediaDir = path.join(root, "media");
  fs.mkdirSync(mediaDir); const file = path.join(root, "source.md"); fs.writeFileSync(file, "# 创作资料\n\n来自本地文件的正文。", "utf8");
  const table = path.join(root, "data.csv"); fs.writeFileSync(table, "月份,销量\n一月,10\n二月,20", "utf8");
  const workbook = path.join(root, "book.xlsx"); createWorkbook(workbook);
  const server = createWebServer({ distDir: dist, sourceReader: async () => "# 链接资料\n可编辑的链接正文。", mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "create");
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      const input = await page.waitForSelector('input[aria-label="选择资料文件"]'); expect(input).not.toBeNull(); await input!.uploadFile(file);
      await page.waitForSelector('[aria-label="资料文件预览"]', { visible: true });
      expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).not.toContain("来自本地文件");
      const panel = await page.$('[aria-label="资料文件导入"]');
      expect(await panel!.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (process.env.GLINT_SOURCE_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_SOURCE_EVIDENCE, `source-import-${width}.png`) });
      await page.locator('textarea[aria-label="资料文件预览"]').fill("修正后的中文资料");
      await page.locator('button::-p-text(替换资料)').click();
      expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).toBe("修正后的中文资料");
      await page.locator('input[aria-label="资料链接"]').fill("https://example.com");
      await page.locator('button::-p-text(预览链接)').click();
      await page.waitForFunction(() => (document.querySelector('[aria-label="资料文件预览"]') as HTMLTextAreaElement | null)?.value.includes("可编辑的链接正文"));
      expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).toBe("修正后的中文资料");
      await page.locator('button::-p-text(替换资料)').click();
      expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).toContain("可编辑的链接正文");
      await page.$eval('textarea[aria-label="创作资料"]', el => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    const tableInput = await page.waitForSelector('input[aria-label="选择表格文件"]'); await tableInput!.uploadFile(table);
    await page.waitForFunction(() => document.querySelector('[aria-label="表格导入"] table')?.textContent?.includes("一月"));
    const panel = await page.$('[aria-label="表格导入"]');
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      expect(await panel!.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (process.env.GLINT_SOURCE_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_SOURCE_EVIDENCE, `table-import-${width}.png`) });
    }
    expect(await page.$eval('textarea[aria-label="原始表格"]', el => (el as HTMLTextAreaElement).value)).toContain("一月,10");
    await page.locator('textarea[aria-label="原始表格"]').fill("月份,销量\n修正月份,77");
    await page.waitForFunction(() => document.querySelector('[aria-label="表格导入"] table')?.textContent?.includes("修正月份77"));
    await tableInput!.uploadFile(workbook);
    await page.waitForSelector('select[aria-label="工作表"]');
    await page.select('select[aria-label="工作表"]', "1");
    await page.waitForFunction(() => document.querySelector('[aria-label="表格导入"] table')?.textContent?.includes("季度2"));
    if (process.env.GLINT_SOURCE_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_SOURCE_EVIDENCE, "xlsx-import-390.png") });
    await page.$eval('[aria-label="表格导入"] button', element => element.scrollIntoView({ block: "center" }));
    await page.locator('button::-p-text(创建图表工程)').click();
    await page.waitForSelector('[aria-label="共享工程编辑"]', { timeout: 30000 }).catch(async error => { throw new Error(`工程未载入: ${await page.evaluate(() => document.body.innerText)}; 页面错误: ${errors.join("; ")}`, { cause: error }); });
    expect(await page.$eval('[aria-label="共享工程编辑"]', el => el.textContent)).toContain("季度2");
    expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).toContain("季度2,20");
    if (process.env.GLINT_TABLE_RENDER_E2E === "1") {
      await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "生成草稿")!.click());
      await page.waitForSelector('video[aria-label="生成的视频"]', { timeout: 150000 });
      const video = await page.$eval('video[aria-label="生成的视频"]', element => element.getAttribute("src"));
      const response = await fetch(new URL(video!, page.url()));
      expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(10000);
    }
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
