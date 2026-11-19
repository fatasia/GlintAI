import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// Server is imported only after its data paths have been isolated.

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("snaps a dragged clip to an explicitly configured beat and undoes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-grid-browser-"));
  const keys = ["GLINT_DATA_DIR", "GLINT_SESSION_DIR", "GLINT_CACHE_DIR", "GLINT_STYLE_SAMPLE_DIR"] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(root, key);
  if (!process.env.GLINT_TEST_WEB_DIST || !path.isAbsolute(process.env.GLINT_TEST_WEB_DIST)) throw new Error("GLINT_TEST_WEB_DIST must point to an isolated build");
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 720); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "beat-test", title: "节拍测试", fps: 30, width: 1280, height: 720, tracks: [{ id: "t1", kind: "text", name: "字幕", clips: [{ id: "a", kind: "text", text: "卡点", startMs: 0, durationMs: 2000 }] }] };
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]');
    await page.locator('summary::-p-text(节拍吸附)').click();
    const bounds = await page.evaluate(() => {
      const panel = [...document.querySelectorAll("details")].find(el => el.querySelector("summary")?.textContent === "节拍吸附")!;
      const timeline = document.querySelector('[aria-label="多轨时间线"]')!;
      const hint = panel.querySelector("small")!;
      const workspace = document.querySelector(".nle-body")!;
      return { panel: panel.getBoundingClientRect().toJSON(), timeline: timeline.getBoundingClientRect().toJSON(), hint: hint.getBoundingClientRect().toJSON(), workspace: workspace.getBoundingClientRect().toJSON() };
    });
    expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.workspace.bottom);
    expect(bounds.workspace.bottom).toBeLessThanOrEqual(bounds.timeline.top);
    console.log("beat boundaries", JSON.stringify(bounds), "evidence", root);
    await page.screenshot({ path: path.join(root, "before-1280.png") });
    await page.select('[aria-label="节拍来源"]', 'audio');
    const audioBounds = await page.evaluate(() => {
      const panel = [...document.querySelectorAll("details")].find(el => el.querySelector("summary")?.textContent === "节拍吸附")!;
      const status = panel.querySelector('[role="status"]')!;
      const timeline = document.querySelector('[aria-label="多轨时间线"]')!;
      return { status: status.getBoundingClientRect().toJSON(), timeline: timeline.getBoundingClientRect().toJSON(), panel: panel.getBoundingClientRect().toJSON() };
    });
    expect(audioBounds.panel.bottom).toBeLessThanOrEqual(audioBounds.timeline.top);
    await page.$eval('.nle-beat-panel [role="status"]', element => element.scrollIntoView({ block: "nearest" }));
    expect(await page.$eval('.nle-beat-panel', panel => { const r = panel.getBoundingClientRect(); const s = panel.querySelector('[role="status"]')!.getBoundingClientRect(); return s.top >= r.top && s.bottom <= r.bottom; })).toBe(true);
    console.log("audio boundaries", JSON.stringify(audioBounds));
    await page.screenshot({ path: path.join(root, "before-audio-1280.png") });
    await page.select('[aria-label="节拍来源"]', 'manual');
    await page.locator('input[aria-label="启用节拍吸附"]').click();
    expect(await page.$eval('input[aria-label="节拍 BPM"]', input => (input as HTMLInputElement).value)).toBe("120");
    const clip = await page.$('[aria-label="字幕 a"]'); if (!clip) throw new Error("clip missing");
    const rect = await clip.boundingBox(); if (!rect) throw new Error("clip has no bounds");
    await page.mouse.move(rect.x + 30, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 71.2, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].startMs === 500);
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].startMs === 0);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.$eval('section[aria-label="剪辑台"]', element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.locator('input[aria-label="节拍 BPM"]').fill("150");
    expect(await page.$eval('input[aria-label="节拍 BPM"]', input => (input as HTMLInputElement).value)).toBe("150");
    await page.$eval('.nle-beat-panel', element => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(root, "after-390.png") });
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  }
}, 60_000);
