import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server tested over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("previews NLE changes, protects newer edits and applies one undoable transaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-proposal-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(media, {}) }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); browser = await openCaptureBrowser(1280, 900);
    const page = browser.page; await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]');
    const project = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!));
    project.tracks.find((track: { id: string }) => track.id === "t1").clips.push({ id: "proposal-a", kind: "text", text: "提案字幕", startMs: 0, durationMs: 2000 });
    const file = path.join(root, "proposal.json"); fs.writeFileSync(file, JSON.stringify(project));
    const select = async () => { const input = await page.$('input[aria-label="选择 NLE 修改提案"]'); await input!.uploadFile(file); await page.waitForSelector('[aria-label="修改差异预览"]'); };
    await select(); expect(await page.$eval('[aria-label="修改差异预览"]', element => element.textContent)).toContain("提案字幕");
    await page.locator('input[aria-label="剪辑标题"]').fill("更新过的标题");
    expect(await page.$eval('[aria-label="修改差异预览"] button::-p-text(应用修改)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[aria-label="修改差异预览"] button::-p-text(取消)').click();
    await page.locator('input[aria-label="剪辑标题"]').fill("未命名剪辑"); await select();
    if (process.env.GLINT_NLE_PROPOSAL_EVIDENCE) await (await page.$('[aria-label="修改差异预览"]'))!.screenshot({ path: path.join(process.env.GLINT_NLE_PROPOSAL_EVIDENCE, "preview.png") });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="修改差异预览"]');
    const bounds = await panel!.boundingBox(); expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(true);
    if (process.env.GLINT_NLE_PROPOSAL_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_NLE_PROPOSAL_EVIDENCE, "preview-mobile.png") });
    await page.locator('button::-p-text(应用修改)').click();
    await page.waitForSelector('[aria-label="多轨时间线"] [aria-label*="proposal-a"]', { timeout: 10000 });
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="多轨时间线"] [aria-label*="proposal-a"]'));
  } finally { await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
