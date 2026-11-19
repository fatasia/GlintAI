import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { runMediaProcess } from "../../studio/scripts/native-process";
// @ts-expect-error JavaScript server exercised through HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("imports PNG/JPEG/WebP and verifies transparent output through a simulated gateway", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-gateway-cutout-browser-"));
  const library = path.join(root, "media"); fs.mkdirSync(library);
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined, server: Server | undefined;
  try {
    const inputs = ["png", "jpg", "webp"].map(ext => path.join(root, `source.${ext}`));
    for (const file of inputs) await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32:r=1", "-frames:v", "1", "-threads", "1", file]);
    const transparent = path.join(root, "transparent.png");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=32x32:r=1,format=rgba", "-vf", "drawbox=x=8:y=8:w=16:h=16:color=red@1:t=fill:replace=1", "-frames:v", "1", "-threads", "1", transparent]);
    const client = {
      models: vi.fn(async () => [{ id: "tt-image-2.5", name: "TT Image 2.5", tags: ["图生图", "透明背景"] }]),
      pricing: vi.fn(async () => ({ channel_groups: [{ is_active: true, billing_method: "按次", base_price: 0.01, supported_options: { background: ["transparent"] } }] })),
      submit: vi.fn(async () => "mock-cutout-1"),
      status: vi.fn(async () => ({ task_id: "mock-cutout-1", state: "success", is_final: true, cost: 0.01, result_url: "https://mock.invalid/result.png" })),
    };
    const jobs = createMediaJobs(library, { GLINT_MEDIA_BASE_URL: "https://mock.invalid", GLINT_MEDIA_API_KEY: "test" }, { client, download: async () => ({ contentType: "image/png", bytes: fs.readFileSync(transparent) }) });
    server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: jobs, requestLogDir: path.join(root, "logs") }) as Server;
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.locator('.app-rail button::-p-text(素材)').click();
    await page.waitForSelector('[aria-label="网关图片编辑"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="网关图片编辑"]')?.textContent?.includes("已检测到图生图与透明背景能力"));
    const upload = await page.$('input[aria-label="导入透明编辑图片"]'); if (!upload) throw new Error("image input missing");
    const names: string[] = [];
    for (const [index, file] of inputs.entries()) {
      await upload.uploadFile(file);
      await page.waitForFunction(count => (document.querySelector('[aria-label="透明编辑参考图"]') as HTMLSelectElement).options.length === count + 2, {}, index);
      const name = await page.$eval('[aria-label="透明编辑参考图"]', element => (element as HTMLSelectElement).value);
      expect(name).toMatch(/^import-[a-f0-9-]+\.(?:png|jpg|webp)$/); names.push(name);
      expect(fs.readFileSync(path.join(library, name)).equals(fs.readFileSync(file))).toBe(true);
    }
    expect(names.map(name => path.extname(name))).toEqual([".png", ".jpg", ".webp"]);
    const generate = await page.$('[aria-label="网关图片编辑"] button::-p-text(生成透明背景)'); if (!generate) throw new Error("submit missing");
    expect(await generate.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[aria-label="网关图片编辑"] input[type="checkbox"]').click();
    await generate.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="网关图片编辑"]')?.textContent?.includes("透明像素检查通过"), { timeout: 30_000 });
    expect(client.submit).toHaveBeenCalledTimes(1);
    const submit = client.submit.mock.calls[0] as unknown as [string, string, { images: string[]; background: string }];
    expect(submit[0]).toBe("tt-image-2.5"); expect(submit[2].background).toBe("transparent");
    expect(submit[2].images).toEqual([`data:image/webp;base64,${fs.readFileSync(inputs[2]!).toString("base64")}`]);
    const pixels = await page.evaluate(async () => {
      const image = document.querySelector('img[alt="网关生成结果"]') as HTMLImageElement;
      if (!image.complete) await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("output not decoded")); });
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparentCount = 0, visibleCount = 0; for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) transparentCount++; if (data[i]! > 0) visibleCount++; }
      return { width: canvas.width, height: canvas.height, transparentCount, visibleCount };
    });
    expect(pixels.width).toBe(32); expect(pixels.height).toBe(32); expect(pixels.transparentCount).toBeGreaterThan(0); expect(pixels.visibleCount).toBeGreaterThan(0);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="网关图片编辑"]'); if (!panel) throw new Error("panel missing");
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (process.env.GLINT_CAPTURE_EVIDENCE && path.isAbsolute(process.env.GLINT_CAPTURE_EVIDENCE)) await panel.screenshot({ path: process.env.GLINT_CAPTURE_EVIDENCE });
  } finally {
    await opened?.browser.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    const realRoot = fs.realpathSync(root), realTemp = fs.realpathSync(os.tmpdir());
    if (path.dirname(realRoot) !== realTemp || !path.basename(realRoot).startsWith("glint-gateway-cutout-browser-")) throw new Error("Unexpected temporary test directory");
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
}, 90_000);
