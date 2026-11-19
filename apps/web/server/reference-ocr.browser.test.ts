import { openHomeTool } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_REFERENCE_OCR_E2E !== "1" || process.platform !== "win32" || !available)("shows real local OCR at sampled reference shots without modifying narration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-real-ocr-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const python = process.env.GLINT_REFERENCE_OCR_PYTHON || execFileSync("python", ["-I", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
  const previous = process.env.GLINT_REFERENCE_OCR_PYTHON; process.env.GLINT_REFERENCE_OCR_PYTHON = python;
  const first = path.join(root, "first.png"), second = path.join(root, "second.png"), video = path.join(mediaDir, "reference.mp4");
  const code = 'from PIL import Image,ImageDraw,ImageFont\nimport sys\nf=ImageFont.truetype("C:/Windows/Fonts/msyh.ttc",120)\nfor p,bg,fg,text in [(sys.argv[1],"white","black","FIRST 24"),(sys.argv[2],"navy","yellow","中文测试 88")]:\n im=Image.new("RGB",(1280,720),bg);ImageDraw.Draw(im).text((100,240),text,font=f,fill=fg);im.save(p)\n';
  execFileSync(python, ["-I", "-c", code, first, second]);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-loop", "1", "-t", "1", "-i", first, "-loop", "1", "-t", "1", "-i", second, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-r", "10", "-c:v", "mpeg4", "-q:v", "2", video], { timeout: 30_000 });
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(mediaDir, {}), requestLogDir: path.join(root, "logs") }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined, done = false;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900); const page = browser.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "reference");
    await page.locator('summary::-p-text(参考片 → 可审阅工程)').click();
    await page.waitForSelector('select[aria-label="选择参考片"] option');
    const checks = await page.$$('[aria-label="从参考片重建工程"] input[type="checkbox"]'); await checks[0]!.click(); await checks[1]!.click();
    const pending = page.waitForResponse(response => response.url().endsWith("/api/reference/build") && response.request().method() === "POST", { timeout: 180_000 });
    await page.locator('button::-p-text(分析并生成工程)').click();
    const response = await pending; const result = await response.json(); done = true;
    expect(response.status()).toBe(200); expect(result.shots).toBe(2); expect(result.ocr.status).toBe("complete");
    const texts = result.ocr.samples.map((sample: { lines: Array<{ text: string }> }) => sample.lines.map(line => line.text).join(" ").toUpperCase());
    expect(texts[0]).toContain("FIRST"); expect(texts[1]).toContain("中文测试");
    const boundary = result.boundaries[0].startMs;
    const lastDuration = result.project.scenes[1].narration.durationMs;
    expect(result.ocr.samples.map((sample: { requestedMs: number }) => sample.requestedMs)).toEqual([
      Math.floor(boundary / 2), Math.floor((boundary * 2 + lastDuration) / 2),
    ]);
    expect(JSON.stringify(result.project.scenes)).not.toContain("FIRST");
    await page.waitForSelector('[aria-label="参考画面文字识别"]');
    await page.locator('summary::-p-text(画面文字识别)').click();
    const content = await page.$eval('[aria-label="参考画面文字识别"]', element => element.textContent);
    expect(content?.toUpperCase()).toContain("FIRST"); expect(content).toContain("模型评分");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="参考画面文字识别"]'); expect(await panel!.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  } finally {
    await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_REFERENCE_OCR_PYTHON; else process.env.GLINT_REFERENCE_OCR_PYTHON = previous;
    if (done) fs.rmSync(root, { recursive: true, force: true }); else console.log("REFERENCE_OCR_DIAGNOSTIC_RETAINED", root);
  }
}, 240_000);
