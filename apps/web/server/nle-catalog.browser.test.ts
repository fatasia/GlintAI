import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised by a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No browser download during tests. */ }
const enabled = process.env.GLINT_BROWSER_UI_TEST === "1" && browserAvailable;
const project = {
  schemaVersion: 1, id: "catalog-browser", title: "预设库验收", fps: 30, width: 640, height: 360,
  tracks: [
    { id: "t1", kind: "text", name: "字幕", clips: [{ id: "caption", kind: "text", text: "真实预览", color: "#e0533d", startMs: 0, durationMs: 6000 }] },
    { id: "a1", kind: "audio", name: "旁白", clips: [{ id: "tone", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 6000 }] },
    { id: "a2", kind: "audio", name: "静音轨", clips: [] },
  ],
};

function stereoWav() {
  const rate = 8000, samples = rate * 6, buffer = Buffer.alloc(44 + samples * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 4, 40);
  for (let index = 0; index < samples; index++) {
    buffer.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 880) * 12000), 44 + index * 4);
    buffer.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 1320) * 6000), 46 + index * 4);
  }
  return buffer;
}

it.skipIf(!enabled)("browses presets without writes, applies and undoes, and meters real stereo audio with dynamic mute and solo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-catalog-browser-"));
  const media = path.join(root, "media"); fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, "tone.wav"), stereoWav());
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(media, {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900);
    const { page } = opened, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.locator('button::-p-text(剪辑台)').click();
    await page.waitForSelector('[aria-label="字幕 caption"]');
    await page.locator('[aria-label="字幕 caption"]').click();
    await page.locator('[aria-label="素材库视图"] button::-p-text(滤镜与转场)').click();
    await page.locator('button[aria-label="预览简洁黑白"]').click();
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0]);
    expect(before.effects).toBeUndefined();
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="预设画面预览"] [style*="grayscale"]')));
    await page.locator('button::-p-text(应用到选中片段)').click();
    await page.waitForFunction(() => document.body.textContent!.includes("已应用简洁黑白"));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].effects[0].kind)).toBe("grayscale");
    await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].effects);
    await page.locator('[aria-label="滤镜与转场库"] button::-p-text(转场)').click();
    await page.locator('button[aria-label="预览擦除"]').click();
    await page.select('[aria-label="转场库位置"]', "out");
    await page.locator('button::-p-text(应用到选中片段)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0].transitionOut?.type === "wipe");
    await page.locator('button[aria-label="字幕 锁定"]').click();
    await page.waitForFunction(() => document.body.textContent!.includes("轨道已锁定，请解锁后再应用"));
    expect(await page.$eval('[aria-label="滤镜与转场库"] button[title*="轨道已锁定"]', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('button[aria-label="字幕 锁定"]').click();

    // Unequal channel amplitudes prove that the analyser sees actual decoded stereo samples.
    await page.locator('button[aria-label="播放"]').click();
    await page.waitForFunction(() => {
      const meters = document.querySelectorAll('[aria-label="音频电平表"] > div > div');
      return meters.length === 2 && parseFloat((meters[0] as HTMLElement).style.height) > parseFloat((meters[1] as HTMLElement).style.height) + 3;
    }, { timeout: 15_000 });
    await page.locator('button[aria-label="旁白 静音"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].every(element => element.paused));
    await page.locator('button[aria-label="旁白 静音"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some(element => !element.paused));
    await page.locator('button[aria-label="静音轨 独听"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[2].solo === true);
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].every(element => element.paused));
    expect(await page.$eval('[aria-label="静音轨 独听"]', element => element.getAttribute("aria-pressed"))).toBe("true");
    await page.locator('button[aria-label="暂停"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="音频电平表"] > div > div')].every(element => (element as HTMLElement).style.height === "0%"));
    expect(await page.$$('section[aria-label="剪辑台"] [role="alert"]')).toHaveLength(0);
    expect(errors).toEqual([]);
    await page.$eval('[aria-label="素材库"]', element => { element.scrollTop = 0; });
    await page.locator('button[aria-label="跳到开头"]').click();
    for (const width of [1440, 768, 390]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      const boxes = await page.$eval('[aria-label="滤镜与转场库"]', element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      expect(boxes.left).toBeGreaterThanOrEqual(0);
      expect(boxes.right).toBeLessThanOrEqual(width);
      if (process.env.GLINT_NLE_CATALOG_EVIDENCE) {
        const evidence = path.resolve(process.env.GLINT_NLE_CATALOG_EVIDENCE);
        fs.mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, `catalog-${width}.png`), fullPage: width <= 768 });
      }
    }
  } finally {
    await opened?.browser.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
