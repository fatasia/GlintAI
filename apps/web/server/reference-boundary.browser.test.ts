import { openHomeTool } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { runMediaProcess } from "../../studio/scripts/native-process";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("reviews and changes a reference boundary at desktop and mobile widths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-boundary-browser-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const video = path.join(media, "sample.mp4");
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", video]);
  const sha256 = createHash("sha256").update(fs.readFileSync(video)).digest("hex");
  const project = { schemaVersion: 1, id: "reference-cut", title: "参考片", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "ref-shot-001", kind: "image", src: "assets/one.jpg", narration: { text: "第一镜", durationMs: 1000 } },
    { id: "ref-shot-002", kind: "image", src: "assets/two.jpg", narration: { text: "第二镜", durationMs: 2000 } },
  ] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}),
    referenceBuilder: async () => ({ project, shots: 2, source: { name: "sample.mp4", sha256, durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.25 }], ocr: { status: "complete", samples: [{ sceneId: "ref-shot-001", requestedMs: 500, status: "recognized", lines: [{ text: "合成测试", score: 0.75 }] }, { sceneId: "ref-shot-002", requestedMs: 2000, status: "no_text", lines: [] }] }, inferred: true }) }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900); const page = browser.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "reference");
    await page.locator('summary::-p-text(参考片 → 可审阅工程)').click();
    await page.waitForSelector('select[aria-label="选择参考片"] option[value="sample.mp4"]');
    await page.locator('[aria-label="从参考片重建工程"] input[type="checkbox"]').click();
    await page.locator('button::-p-text(分析并生成工程)').click();
    await page.waitForSelector('input[aria-label="切点时间 ref-shot-002"]');
    await page.locator('summary::-p-text(画面文字识别)').click();
    expect(await page.$eval('[aria-label="参考画面文字识别"]', el => el.textContent)).not.toContain("已过期");
    await page.locator('textarea[aria-label="人工核对文字 ref-shot-001"]').fill("人工核对的合成文字");
    await page.locator('button::-p-text(写入该镜画面说明)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("已将人工核对文字写入该镜画面说明"));
    expect(await page.$eval('[aria-label="参考画面文字识别"]', el => el.textContent)).toContain("该镜已有画面说明");
    await page.locator('summary::-p-text(切点测量)').click();
    await page.locator('input[aria-label="切点时间 ref-shot-002"]').fill("1.5");
    await page.locator('button::-p-text(调整此切点)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("当前 1.50 秒"));
    expect(await page.$eval('[aria-label="从参考片重建工程"]', el => el.textContent)).toContain("参考帧未重新抽取");
    expect((await page.$eval('[aria-label="参考画面文字识别"]', el => el.textContent))?.match(/已过期/g)).toHaveLength(2);
    const response = page.waitForResponse(result => result.url().endsWith("/api/reference/frames"));
    await page.locator('button::-p-text(重抽相邻参考帧)').click();
    const frames = await (await response).json(); expect(frames.times).toEqual([750, 2250]); expect(frames.names).toHaveLength(2);
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("已按当前切点重抽相邻镜头"));
    expect(frames.names.every((name: string) => fs.existsSync(path.join(media, name)))).toBe(true);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="从参考片重建工程"]');
    expect(await panel!.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  } finally { await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("switches reliably between local upload and library reference videos", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-reference-source-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const local = path.join(root, "local.mp4"), library = path.join(media, "library.mp4");
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1", "-c:v", "mpeg4", local]);
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1", "-c:v", "mpeg4", library]);
  const names: string[] = [];
  const project = { schemaVersion: 1, id: "reference-source", title: "合成测试", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "ref-shot-001", kind: "image", src: "assets/one.jpg", narration: { text: "一", durationMs: 1000 } }] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), referenceBuilder: async ({ name }: { name: string }) => { names.push(name); if (names.length === 1) throw new Error("测试失败，请重试"); return { project, shots: 1, inferred: true }; } }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900); const page = browser.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "reference"); await page.locator('summary::-p-text(参考片 → 可审阅工程)').click();
    await page.waitForSelector('select[aria-label="选择参考片"] option[value="library.mp4"]');
    await page.locator('[aria-label="从参考片重建工程"] input[type="checkbox"]').click();
    const input = await page.$('input[aria-label="上传参考片"]'); await input!.uploadFile(local);
    await page.locator('button::-p-text(刷新列表)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("待上传：local.mp4"));
    expect(await page.$eval('select[aria-label="选择参考片"]', el => (el as HTMLSelectElement).value)).toBe("");
    await page.select('select[aria-label="选择参考片"]', "library.mp4");
    expect(await page.$eval('input[aria-label="上传参考片"]', el => (el as HTMLInputElement).files?.length)).toBe(0);
    await page.locator('button::-p-text(分析并生成工程)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"] [role="alert"]')?.textContent?.includes("测试失败"));
    expect(names).toEqual(["library.mp4"]);
    await input!.uploadFile(local);
    const upload = page.waitForResponse(response => response.url().endsWith("/api/reference/upload"));
    await page.locator('button::-p-text(上传并生成工程)').click();
    expect((await upload).status()).toBe(201);
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("已生成 1 镜"));
    expect(names).toHaveLength(2); expect(names[0]).toBe("library.mp4"); expect(names[1]).not.toBe("library.mp4");
    expect(fs.readFileSync(path.join(media, names[1]!))).toEqual(fs.readFileSync(local));
    expect(await page.$eval('input[aria-label="上传参考片"]', el => (el as HTMLInputElement).files?.length)).toBe(0);
    await input!.uploadFile(local);
    expect(await page.$eval('[aria-label="从参考片重建工程"]', el => el.textContent)).toContain("待上传：local.mp4");
  } finally { await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("edits an overlap-transition boundary by its dissolve centre in the browser", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-boundary-overlap-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const video = path.join(media, "sample.mp4");
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", video]);
  const sha256 = createHash("sha256").update(fs.readFileSync(video)).digest("hex");
  // 交叠工程：右镜 700–2700ms，转场中心 850ms。
  const project = { schemaVersion: 1, id: "reference-overlap", title: "交叠参考片", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "ref-shot-001", kind: "image", src: "assets/one.jpg", narration: { text: "第一镜", durationMs: 1000 } },
    { id: "ref-shot-002", kind: "image", src: "assets/two.jpg", narration: { text: "第二镜", durationMs: 2000 }, transition: { in: "fade", overlapMs: 300 } },
  ] };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}),
    referenceBuilder: async () => ({ project, shots: 2, source: { name: "sample.mp4", sha256, durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 700, change: 0.25 }], inferred: true }) }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900); const page = browser.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "reference");
    await page.locator('summary::-p-text(参考片 → 可审阅工程)').click();
    await page.waitForSelector('select[aria-label="选择参考片"] option[value="sample.mp4"]');
    await page.locator('[aria-label="从参考片重建工程"] input[type="checkbox"]').click();
    await page.locator('button::-p-text(分析并生成工程)').click();
    await page.waitForSelector('input[aria-label="切点时间 ref-shot-002"]');
    await page.locator('summary::-p-text(切点测量)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("当前 0.85 秒"));
    await page.locator('input[aria-label="切点时间 ref-shot-002"]').fill("1.35");
    await page.locator('button::-p-text(调整此切点)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="从参考片重建工程"]')?.textContent?.includes("当前 1.35 秒"));
    const boundary = page.waitForResponse(result => result.url().endsWith("/api/reference/frames"));
    await page.locator('button::-p-text(重抽相邻参考帧)').click();
    const frames = await (await boundary).json();
    // 调整后：左镜 0–1500，右镜 1200–2700；两镜中点 750 与 1950。
    expect(frames.times).toEqual([750, 1950]); expect(frames.names).toHaveLength(2);
    expect(frames.names.every((name: string) => fs.existsSync(path.join(media, name)))).toBe(true);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="从参考片重建工程"]');
    expect(await panel!.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  } finally { await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
