import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openRestoredProject } from "./browser-workspace-helpers";

let browserAvailable = false; try { findSystemBrowser(); browserAvailable = true; } catch { /* opt-in only */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("both starts share a saved project with footage, motion graphics and undoable text animation", async () => {
  const root = process.env.GLINT_DATA_DIR, sessionDir = process.env.GLINT_SESSION_DIR;
  if (!root || !sessionDir) throw new Error("Explicit isolated data directories are required");
  const evidence = process.env.GLINT_HYBRID_EVIDENCE ?? root;
  fs.mkdirSync(evidence, { recursive: true }); const media = path.join(root, "media"); fs.mkdirSync(media, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path.join(media, "tea.mp4")], { windowsHide: true });
  const { createWebServer } = await import("./index.mjs"), { createMediaJobs } = await import("./media-jobs.mjs");
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST, mediaJobs: createMediaJobs(media, {}), sessionStore: new FileSessionStore(sessionDir, value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1440, 900); const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    expect(await page.$$eval('[aria-label="视频创作起点"] [aria-pressed="true"]', items => items.length)).toBe(0);
    await page.locator('[aria-label="视频创作起点"] button::-p-text(影像创作)').click();
    await page.waitForSelector('[aria-label="作品名称"]');
    await page.locator('[aria-label="作品名称"]').fill("茶馆混合创作");
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(evidence, `start-${width}.png`) });
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.locator('[aria-label="从素材库视频开始"] button::-p-text(tea.mp4)').click();
    await openRestoredProject(page);
    await page.locator('.hybrid-tools button::-p-text(叠加文字动画)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes[0]?.elements?.length === 1);
    await page.locator('.glint-editor button[aria-label="撤销"]').click();
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes[0]?.elements?.length);
    await page.locator('.glint-editor button[aria-label="重做"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes[0]?.elements?.length === 1);
    await page.locator('.hybrid-tools button::-p-text(添加动态图形)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.length === 2);
    const project = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project);
    expect(project.scenes.map((scene: { kind: string }) => scene.kind)).toEqual(["video", "title"]);
    expect(project.scenes[0].narration.durationMs).toBe(2000); expect(project.scenes[0].tracks[0].property).toBe("opacity");
    fs.writeFileSync(path.join(evidence, "mixed-project.json"), JSON.stringify(project, null, 2));
    await page.reload({ waitUntil: "networkidle0" }); await openRestoredProject(page);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project)).toEqual(project);
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(evidence, `mixed-${width}.png`) });
    }
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120_000);
