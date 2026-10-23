import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { createMediaSettings } from "./media-settings.mjs";

/**
 * Live gateway validation against a real provider. Opt-in and credential-gated:
 * set GLINT_MEDIA_BASE_URL / GLINT_MEDIA_API_KEY (and GLINT_LIVE_VIDEO=1 for the
 * paid video call). Costs are reported, never guessed.
 */
const base = process.env.GLINT_MEDIA_BASE_URL;
const key = process.env.GLINT_MEDIA_API_KEY;
const gatewayOrigin = base ? base.replace(/\/+$/, "").replace(/\/v1$/, "") : "";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-live-media-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const enabled = Boolean(base && key);
const publicDns = process.env.GLINT_MEDIA_PUBLIC_DNS === "1";

it.skipIf(!enabled)("generates a real image through the configured gateway and downloads it", async () => {
  const client = new MediaGatewayClient({ baseUrl: base!, apiKey: key!, pollIntervalMs: 5000 });
  const models = await client.models("image");
  const model = models.find(item => item.id === "tt-image-2.5")?.id ?? models[0]?.id;
  expect(model, "image model catalog").toBeTruthy();
  const taskId = await client.submit(model!, "一只橘猫坐在窗台上，柔和日光，写实摄影", { size: "1024x1024" });
  const task = await client.wait(taskId, { timeoutMs: 600_000 });
  const media = await downloadMediaResult(task, AbortSignal.timeout(120_000), { publicDns });
  const file = path.join(root, "image.bin");
  fs.writeFileSync(file, media.bytes);
  const magic = media.bytes.subarray(0, 12);
  const isPng = magic.subarray(1, 4).toString() === "PNG";
  const isJpeg = magic[0] === 0xff && magic[1] === 0xd8;
  expect(isPng || isJpeg, `unexpected image bytes: ${media.contentType}`).toBe(true);
  expect(media.bytes.length).toBeGreaterThan(10_000);
  console.log(`[live] image ${model} ok · ${media.bytes.length} bytes · cost ${task.cost ?? "n/a"}`);
}, 660_000);

it.skipIf(!enabled || process.env.GLINT_LIVE_VIDEO !== "1")("generates a real 480P video and downloads it", async () => {
  const client = new MediaGatewayClient({ baseUrl: base!, apiKey: key!, pollIntervalMs: 10_000 });
  const taskId = await client.submit("hailuo-h3-max", "清晨的海边，镜头缓慢向前推进，海鸟掠过，写实电影感", { aspect: "16:9", duration: 5, resolution: "480P" });
  const task = await client.wait(taskId, { timeoutMs: 900_000 });
  const media = await downloadMediaResult(task, AbortSignal.timeout(180_000), { publicDns });
  const file = path.join(root, "video.mp4");
  fs.writeFileSync(file, media.bytes);
  expect(media.bytes.length).toBeGreaterThan(100_000);
  expect(media.bytes.subarray(4, 8).toString()).toBe("ftyp");
  console.log(`[live] video hailuo-h3-max ok · ${(media.bytes.length / 1024 / 1024).toFixed(1)} MiB · cost ${task.cost ?? "n/a"}`);
}, 960_000);
it.skipIf(!enabled)("serves a real generated image through the app HTTP API", async () => {
  const mediaDir = path.join(root, "media"), sessionsDir = path.join(root, "sessions");
  const jobs = createMediaJobs(mediaDir, { GLINT_MEDIA_BASE_URL: base!, GLINT_MEDIA_API_KEY: key!, GLINT_MEDIA_PUBLIC_DNS: publicDns ? "1" : "0" });
  const server = createWebServer({ mediaJobs: jobs, sessionStore: new FileSessionStore(sessionsDir, document => { parseProject(document); }) }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const submitted = await (await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "image", model: "tt-image-2.5", prompt: "简洁的产品摄影，白色背景，柔和光线", params: { size: "1024x1024" }, requestId: randomUUID() }) })).json();
    expect(submitted.taskId).toBeTruthy();
    let task = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(done => setTimeout(done, 5000));
      task = await (await fetch(`${origin}/api/media/status/${submitted.taskId}`)).json();
      if (task.isFinal) break;
    }
    expect(task?.state, JSON.stringify(task).slice(0, 300)).toBe("success");
    expect(task.assetUrl).toMatch(/^\/api\/media\/assets\//);
    const asset = await fetch(`${origin}${task.assetUrl}`);
    expect(asset.status).toBe(200);
    const bytes = Buffer.from(await asset.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    console.log(`[live] app image ok · ${bytes.length} bytes · cost ${task.cost ?? "n/a"}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 700_000);
it.skipIf(!enabled || process.env.GLINT_LIVE_OPENAI_IMAGES !== "1")("switches the app to OpenAI Images and generates through the HTTP API", async () => {
  const mediaDir = path.join(root, "openai-media"), sessionsDir = path.join(root, "openai-sessions");
  const jobs = createMediaJobs(mediaDir, { GLINT_MEDIA_PUBLIC_DNS: publicDns ? "1" : "0" });
  const settings = createMediaSettings({ file: path.join(root, "media-settings.json"), env: {} });
  const server = createWebServer({ mediaJobs: jobs, mediaSettings: settings, sessionStore: new FileSessionStore(sessionsDir, document => { parseProject(document); }) }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = await (await fetch(`${gatewayOrigin}/v1/skills/balance`, { headers: { authorization: `Bearer ${key}` } })).json();
    const saved = await (await fetch(`${origin}/api/settings/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: base, apiKey: key, protocol: "openai-images" }) })).json();
    expect(saved.protocol).toBe("openai-images");
    const catalog = await (await fetch(`${origin}/api/media/models?type=image`)).json();
    expect(catalog.protocol).toBe("openai-images");
    const model = catalog.models.find((item: { id: string }) => item.id === "tt-image-2.5")?.id ?? catalog.models[0]?.id;
    expect(model, "OpenAI Images image catalog").toBeTruthy();
    const submitted = await (await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "image", model, prompt: "安静的木质桌面，一杯咖啡，柔和晨光，写实摄影", params: { size: "1024x1024" }, requestId: randomUUID() }) })).json();
    expect(submitted.taskId).toBeTruthy();
    const task = await (await fetch(`${origin}/api/media/status/${submitted.taskId}`)).json();
    expect(task, JSON.stringify(task).slice(0, 300)).toMatchObject({ state: "success", isFinal: true });
    const asset = await fetch(`${origin}${task.assetUrl}`);
    expect(asset.status).toBe(200);
    const bytes = Buffer.from(await asset.arrayBuffer());
    const isPng = bytes.subarray(1, 4).toString() === "PNG", isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    expect(isPng || isJpeg, `unexpected image bytes: ${asset.headers.get("content-type")}`).toBe(true);
    expect(bytes.length).toBeGreaterThan(10_000);
    const after = await (await fetch(`${gatewayOrigin}/v1/skills/balance`, { headers: { authorization: `Bearer ${key}` } })).json();
    console.log(`[live] openai-images ${model} ok · ${bytes.length} bytes · balance ${before.balance} → ${after.balance}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 700_000);