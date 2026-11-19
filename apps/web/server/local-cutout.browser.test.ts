import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised through a real browser.
import { createWebServer } from "./index.mjs";
import { createLocalCutout } from "./local-cutout.mjs";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const photo = fileURLToPath(new URL("../../../evidence/DRAMA-03/live-reference-20261027/media/191608366.png", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No downloads. */ }

it.skipIf(process.env.GLINT_CUTOUT_LIVE_E2E !== "1" || !browserAvailable)("runs a configured U²-Net model on a complex-background image through the browser", async () => {
  const cutout = createLocalCutout();
  if (!cutout.configured() || !fs.existsSync(photo) || !fs.existsSync(path.join(dist, "index.html"))) throw new Error("Configure cutout paths and build glint-web before this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-cutout-real-"));
  const server = createWebServer({ localCutout: cutout, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.locator('.rail-button::-p-text(素材)').click();
    await page.waitForSelector('[aria-label="本地抠图和放大"]');
    await page.waitForFunction(() => !(document.querySelector('[aria-label="本地图片处理方式"] option[value="ai"]') as HTMLOptionElement)?.disabled);
    const input = await page.$('input[aria-label="选择本地图片"]');
    if (!input) throw new Error("Missing file input");
    await input.uploadFile(photo);
    await page.select('[aria-label="本地图片处理方式"]', "ai");
    await page.locator('[aria-label="本地抠图和放大"] button::-p-text(生成透明 PNG)').click();
    await page.waitForSelector('img[alt="本地处理结果"]', { timeout: 125_000 });
    const output = await page.evaluate(async () => {
      const image = document.querySelector('img[alt="本地处理结果"]') as HTMLImageElement;
      if (!image.complete) await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot decode output")); });
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0, opaque = 0; for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]! < 16) transparent++; if (pixels[i]! > 239) opaque++; }
      return { width: canvas.width, height: canvas.height, transparent, opaque };
    });
    expect(output.width).toBe(1448); expect(output.height).toBe(1086);
    expect(output.transparent).toBeGreaterThan(1000); expect(output.opaque).toBeGreaterThan(1000);
    console.log("U²-Net alpha:", output);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 150_000);
