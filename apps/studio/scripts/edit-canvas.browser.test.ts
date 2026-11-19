import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "./direct-browser/host";
// @ts-expect-error JavaScript server exercised by a real browser.
import { createWebServer } from "../../web/server/index.mjs";
// @ts-expect-error JavaScript media jobs helper.
import { createMediaJobs } from "../../web/server/media-jobs.mjs";

// EDIT-01 (box/multi select with a visible marquee) and EDIT-02 (snap guide
// rendering) verified against a production web build with a real Chrome.
// Evidence screenshots land under $GLINT_EDIT_EVIDENCE when that env is set.
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }
const enabled = process.env.GLINT_BROWSER_UI_TEST === "1" && browserAvailable;
const evidenceRoot = process.env.GLINT_EDIT_EVIDENCE ?? path.join(os.tmpdir(), "glint-edit-evidence");
const shot = async (page: import("puppeteer-core").Page, task: string, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  const file = path.join(evidenceRoot, task, "run-20261025b", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  return file;
};
// NleProject only allows video/image clips on video tracks; text lives on
// text/overlay tracks. Text tracks stay inside EDIT-02's magnetized set.
const project = {
  schemaVersion: 1, id: "edit-demo", title: "框选与对齐", fps: 30, width: 960, height: 540,
  tracks: [
    { id: "v1", kind: "text", name: "V1 主画面", clips: [{ id: "a", kind: "text", text: "片段甲", startMs: 0, durationMs: 2000 }] },
    { id: "v2", kind: "overlay", name: "V2 叠加", clips: [{ id: "b", kind: "text", text: "片段乙", startMs: 4000, durationMs: 2000 }] },
  ],
};

it.skipIf(!enabled)("box selection draws a marquee, selects covered clips and clears on empty click", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(fs.mkdtempSync(path.join(os.tmpdir(), "glint-edit-media-")), {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 960);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.locator('button::-p-text(剪辑台)').click();
    await page.waitForSelector('[aria-label="多轨时间线"]');
    const aBox = await (await page.$('[aria-label="V1 主画面 a"]'))!.boundingBox() as { x: number; y: number; width: number; height: number };
    const bBox = await (await page.$('[aria-label="V2 叠加 b"]'))!.boundingBox() as { x: number; y: number; width: number; height: number };
    expect(aBox.y).toBeLessThan(bBox.y);
    // Start in empty lane space, not the track controls. Drag back across both
    // rows; the marquee must be visible before pointer-up.
    const startX = bBox.x + bBox.width + 30, startY = bBox.y + bBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 140, startY - 20, { steps: 4 });
    await page.waitForSelector('[data-band]');
    const band = await page.$eval('[data-band]', element => ({ w: element.clientWidth, h: element.clientHeight }));
    expect(band.w).toBeGreaterThan(40);
    expect(band.h).toBeGreaterThan(10);
    await shot(page, "EDIT-01", "box-select-drag.png");
    await page.mouse.move(aBox.x + 2, aBox.y + 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.body.innerText.includes("已选 2"), { timeout: 10_000 });
    const selected = await page.$$eval('[aria-label="多轨时间线"] [aria-pressed="true"]', elements => elements.map(element => element.getAttribute("aria-label")));
    expect(selected).toEqual(expect.arrayContaining(["V1 主画面 a", "V2 叠加 b"]));
    await shot(page, "EDIT-01", "box-select-selected.png");
    // A click on empty lane space keeps the seek but clears the selection.
    await page.mouse.click(aBox.x + aBox.width + 40, aBox.y + 10);
    await page.waitForFunction(() => !document.body.innerText.includes("已选 2"), { timeout: 10_000 });
    expect(await page.$$('[aria-label="多轨时间线"] [aria-pressed="true"]')).toHaveLength(0);
    await shot(page, "EDIT-01", "box-select-cleared.png");
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90_000);

it.skipIf(!enabled)("dragging toward a neighbour snaps and paints a labelled alignment guide", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(fs.mkdtempSync(path.join(os.tmpdir(), "glint-align-media-")), {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 960);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.locator('button::-p-text(剪辑台)').click();
    await page.waitForSelector('[aria-label="V2 叠加 b"]');
    const bBox = await (await page.$('[aria-label="V2 叠加 b"]'))!.boundingBox() as { x: number; y: number; width: number; height: number };
    // b starts at 4000ms; a -2100ms drag aims at 1900ms, inside the 100ms snap
    // threshold of a's right edge (2000ms).
    const expectedGuide = await page.$eval('[aria-label="V1 主画面 a"]', element => {
      const clip = element.getBoundingClientRect();
      const timeline = element.closest('.nle-tl-inner')!.getBoundingClientRect();
      return clip.right - timeline.left;
    });
    await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(bBox.x + bBox.width / 2 - 168, bBox.y + bBox.height / 2, { steps: 8 });
    await page.waitForSelector('[data-snap-guide]', { timeout: 10_000 });
    const guide = await page.$eval('[data-snap-guide]', element => ({ left: (element as HTMLElement).style.left, text: element.textContent }));
    expect(parseFloat(guide.left)).toBeCloseTo(expectedGuide, 0);
    expect(guide.text).toContain("2000ms");
    const timeline = await (await page.$('[aria-label="多轨时间线"]'))!.boundingBox() as { x: number; y: number; width: number; height: number };
    await shot(page, "EDIT-02", "align-guide.png", { x: timeline.x, y: timeline.y, width: Math.min(timeline.width, 1200), height: timeline.height });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem("glint.nle.project.v2")!) as { tracks: Array<{ id: string; clips: Array<{ id: string; startMs: number }> }> };
      return stored.tracks.find(track => track.id === "v2")?.clips.find(clip => clip.id === "b")?.startMs === 2000;
    }, { timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90_000);
