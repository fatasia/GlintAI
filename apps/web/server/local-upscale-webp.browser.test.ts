import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createLocalUpscale } from "./local-upscale.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { createMediaSettings } from "./media-settings.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = path.join(repo, "evidence/GEN-08/local-upscale-webp-20261028-independent");
const runtime = path.join(repo, ".cache/glint-realesrgan-0f904e4d-c74f-46b2-b3e4-2c376426b839/extracted-20261027");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No browser download. */ }

it.skipIf(process.env.GLINT_UPSCALE_LIVE_E2E !== "1" || !browserAvailable)("recovers from a corrupt WebP and downloads a real transparent 4x result through the product HTTP route", async () => {
  const input = path.join(evidence, "lossless.webp");
  const previous = path.join(evidence, "lossless-1.png");
  const outputDir = process.env.GLINT_CAPTURE_EVIDENCE;
  if (!outputDir || !path.isAbsolute(outputDir) || fs.existsSync(outputDir)) throw new Error("Provide a new absolute GLINT_CAPTURE_EVIDENCE directory");
  const worker = createLocalUpscale({ executable: path.join(runtime, "realesrgan-ncnn-vulkan.exe"), modelDir: path.join(runtime, "models") });
  if (!worker.configured() || !fs.existsSync(input) || !fs.existsSync(previous)) throw new Error("Existing model and WebP evidence are required");
  fs.mkdirSync(outputDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upscale-webp-browser-"));
  const bad = path.join(root, "corrupt.webp"); fs.writeFileSync(bad, Buffer.from("RIFF0000WEBPbroken"));
  const jobs = createMediaJobs(path.join(root, "media"), {});
  expect(jobs.configured()).toBe(false);
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? path.join(repo, "apps/web/dist"), localUpscale: worker, mediaJobs: jobs, mediaSettings: createMediaSettings({ env: {} }), requestLogDir: path.join(root, "logs") });
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const { browser, page } = opened;
    const errors: string[] = [], blockedExternal: string[] = [], posts: Array<{ status: number; bytes: number; hash: string }> = [];
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (!url.startsWith(`${origin}/`) && !/^(?:blob:|data:|about:)/.test(url)) { blockedExternal.push(url); void request.abort(); }
      else void request.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (response.url() === `${origin}/api/local-upscale` && response.request().method() === "POST") {
        const body = JSON.parse(response.request().postData()!); const bytes = Buffer.from(body.base64, "base64");
        posts.push({ status: response.status(), bytes: bytes.length, hash: digest(bytes) });
      }
    });
    await page.goto(origin, { waitUntil: "networkidle0" });
    await page.locator('.rail-button::-p-text(素材)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本地 AI 超分"]')?.textContent?.includes("本地运行程序和模型已配置。"));
    const upload = await page.$('input[aria-label="选择 AI 超分图片"]'); if (!upload) throw new Error("Missing file input");
    await upload.uploadFile(bad);
    await page.locator('[aria-label="本地 AI 超分"] button::-p-text(4× AI 超分)').click();
    await page.waitForSelector('[aria-label="本地 AI 超分"] [role="alert"]');
    expect(await page.$eval('[aria-label="本地 AI 超分"] [role="alert"]', el => el.textContent)).toMatch(/WebP 文件结构无效/);
    await (await page.$('[aria-label="本地 AI 超分"]'))!.screenshot({ path: path.join(outputDir, "failure.png") });
    await upload.uploadFile(input);
    const response = page.waitForResponse(r => r.url() === `${origin}/api/local-upscale` && r.request().method() === "POST", { timeout: 140_000 });
    await page.locator('[aria-label="本地 AI 超分"] button::-p-text(4× AI 超分)').click();
    expect((await response).status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('[aria-label="本地 AI 超分"] [role="status"]')?.textContent === "输出尺寸 960 × 640", { timeout: 140_000 });
    const pixels = await page.$eval('img[alt="AI 超分结果"]', async (image: HTMLImageElement) => {
      await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let zero = 0, partial = 0, opaque = 0; for (let i = 3; i < data.length; i += 4) { const a = data[i]!; if (a === 0) zero++; else if (a === 255) opaque++; else partial++; }
      return { width: canvas.width, height: canvas.height, zero, partial, opaque };
    });
    expect(pixels).toEqual({ width: 960, height: 640, zero: 295119, partial: 159661, opaque: 159620 });
    await (await page.$('[aria-label="本地 AI 超分"]'))!.screenshot({ path: path.join(outputDir, "result.png") });
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: root, eventsEnabled: true });
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("download timed out")), 20000);
      cdp.on("Browser.downloadProgress", event => { if (event.state === "completed") { clearTimeout(timer); resolve(); } else if (event.state === "canceled") { clearTimeout(timer); reject(new Error("download canceled")); } });
    });
    await page.locator('[aria-label="本地 AI 超分"] a::-p-text(下载 PNG)').click(); await completed;
    const downloaded = fs.readFileSync(path.join(root, "lossless-ai-4x.png"));
    expect(digest(downloaded)).toBe(digest(fs.readFileSync(previous)));
    expect(posts.map(post => post.status)).toEqual([400, 200]);
    expect(posts[1]?.hash).toBe(digest(fs.readFileSync(input))); expect(errors).toEqual([]); expect(blockedExternal).toEqual([]);
    // Synthetic JPEG: reject unknown EXIF orientation, then process a real rotated image.
    const jpeg = path.join(root, "orientation.jpg"), badJpeg = path.join(root, "invalid-orientation.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=80x40,drawbox=x=40:y=0:w=40:h=20:color=green:t=fill,drawbox=x=0:y=20:w=40:h=20:color=blue:t=fill,drawbox=x=40:y=20:w=40:h=20:color=yellow:t=fill", "-frames:v", "1", jpeg]);
    const base = fs.readFileSync(jpeg), exif = Buffer.from("45786966000049492a0008000000010012010300010000000000000000000000", "hex");
    const header = Buffer.alloc(4); header.writeUInt16BE(0xffe1); header.writeUInt16BE(exif.length + 2, 2);
    const withOrientation = (orientation: number) => { const data = Buffer.from(exif); data.writeUInt16LE(orientation, 24); return Buffer.concat([base.subarray(0, 2), header, data, base.subarray(2)]); };
    fs.writeFileSync(badJpeg, withOrientation(9)); fs.writeFileSync(jpeg, withOrientation(6));
    await upload.uploadFile(badJpeg);
    await page.locator('[aria-label="本地 AI 超分"] button::-p-text(4× AI 超分)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本地 AI 超分"] [role="alert"]')?.textContent?.includes("方向元数据无效"));
    await upload.uploadFile(jpeg);
    const rotatedResponse = page.waitForResponse(r => r.url() === `${origin}/api/local-upscale` && r.request().method() === "POST", { timeout: 140_000 });
    await page.locator('[aria-label="本地 AI 超分"] button::-p-text(4× AI 超分)').click();
    expect((await rotatedResponse).status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('[aria-label="本地 AI 超分"] [role="status"]')?.textContent === "输出尺寸 160 × 320", { timeout: 140_000 });
    const corners = await page.$eval('img[alt="AI 超分结果"]', async (image: HTMLImageElement) => {
      await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return [[20, 20], [140, 20], [20, 300], [140, 300]].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data).slice(0, 3));
    });
    const [blue, red, yellow, green] = corners;
    expect(blue![2]).toBeGreaterThan(blue![0]! * 2); expect(red![0]).toBeGreaterThan(red![2]! * 2);
    expect(yellow![0]).toBeGreaterThan(120); expect(yellow![1]).toBeGreaterThan(120); expect(green![1]).toBeGreaterThan(green![0]! * 2);
    expect(posts.map(post => post.status)).toEqual([400, 200, 400, 200]); expect(errors).toEqual([]); expect(blockedExternal).toEqual([]);
    await (await page.$('[aria-label="本地 AI 超分"]'))!.screenshot({ path: path.join(outputDir, "jpeg-result.png") });
    const animated = path.join(root, "animation.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x32:rate=2", "-frames:v", "2", "-plays", "0", "-f", "apng", animated]);
    await upload.uploadFile(animated);
    await page.locator('[aria-label="本地 AI 超分"] button::-p-text(4× AI 超分)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本地 AI 超分"] [role="alert"]')?.textContent?.includes("请先导出所需的静态帧"));
    expect(posts.map(post => post.status)).toEqual([400, 200, 400, 200, 400]);
    expect(errors).toEqual([]); expect(blockedExternal).toEqual([]);
    await (await page.$('[aria-label="本地 AI 超分"]'))!.screenshot({ path: path.join(outputDir, "animation-rejected.png") });
    fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ posts, pixels, jpegCorners: corners, downloadedSha256: digest(downloaded), previousSha256: digest(fs.readFileSync(previous)), errors, blockedExternal, mediaGatewayConfigured: false }, null, 2), { flag: "wx" });
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const real = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    if (path.dirname(real) !== temp || !path.basename(real).startsWith("glint-upscale-webp-browser-")) throw new Error("Unsafe temporary directory");
    fs.rmSync(real, { recursive: true, force: true });
  }
}, 180_000);
