import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no downloads */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("uses the same catalog declaration for UI eligibility and server reference refusal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-catalog-browser-"));
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined, server: Server | undefined;
  let malformed = true;
  const client = { models: vi.fn(async () => [{ id: "tt-image-2.5", name: "本地目录测试", tags: malformed ? ["图生图"] : ["图生图", "透明背景"], capabilityTagsValid: !malformed }]), pricing: vi.fn(async () => ({ channel_groups: [] })), submit: vi.fn() };
  try {
    const media = path.join(root, "media"), jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://catalog.test", GLINT_MEDIA_API_KEY: "fixture" }, { client });
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzH0AAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(media, "hero.png"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: jobs, requestLogDir: path.join(root, "logs") }) as Server;
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 1000); const page = opened.page;
    await page.goto(`${origin}/#/library/create`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector('[aria-label="网关图片编辑"]')?.textContent?.includes("需要在模型连接"));
    const first = await (await fetch(`${origin}/api/media/models?type=image`)).json();
    expect(first.models[0].registry.capabilities).toEqual([]);
    expect(first.models[0].registry.pricing).toEqual({ basis: "unknown" });
    const refusal = await page.evaluate(async sha256 => {
      const r = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image", model: "tt-image-2.5", prompt: "fixture", params: {}, libraryReference: { name: "hero.png", sha256 }, requestId: "catalog-refused" }) });
      return { status: r.status, body: await r.json() };
    }, hash);
    expect(refusal.body.error).toBe("Media request failed. Check gateway configuration and model parameters; do not resubmit an uncertain task.");
    expect(jobs.findRequest("catalog-refused")).toBeNull();
    expect(refusal.status).toBeGreaterThanOrEqual(400); expect(client.submit).not.toHaveBeenCalled();
    malformed = false;
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector('[aria-label="网关图片编辑"]')?.textContent?.includes("已检测到图生图与透明背景能力"));
    const valid = await (await fetch(`${origin}/api/media/models?type=image`)).json();
    expect(valid.models[0].id).toBe("tt-image-2.5"); expect(valid.models[0].registry.capabilities).toEqual(["reference-image", "image-to-image", "transparent-background"]);
    expect(await page.$eval('[aria-label="媒体模型"]', select => (select as HTMLSelectElement).value)).toBe("tt-image-2.5");
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      const panel = await page.$('[aria-label="网关图片编辑"]'); const box = await panel!.boundingBox(); expect(box && box.width <= width).toBe(true);
      if (process.env.GLINT_UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
        await panel!.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `media-catalog-${width}.png`) as `${string}.png` });
      }
    }
    expect(client.submit).not.toHaveBeenCalled();
  } finally {
    await opened?.browser.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
