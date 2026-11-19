import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript server exercised over actual HTTP.
import { createWebServer } from "./index.mjs";

// CREATE-01 公开 URL → 真实成片质量：真实 HTTPS 拉取(example.com)→ 离线启发式
// 工程 → 真实渲染链(Chromium 采帧 + FFmpeg 编码)→ 下载 MP4 探测与像素检查。
// 显式 opt-in(依赖公网可达);不调用网关模型,LLM 撰稿环节未覆盖(如实)。
const PUBLIC_URL = process.env.GLINT_URL_FILM_SOURCE ?? "https://example.com/";

it.skipIf(process.env.GLINT_URL_FILM_E2E !== "1" || process.platform !== "win32")("turns a public URL into a real rendered film through the product routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-url-film-"));
  const previous = process.env.GLINT_DATA_DIR, dns = process.env.GLINT_SOURCE_PUBLIC_DNS;
  process.env.GLINT_DATA_DIR = root;
  if (dns === undefined) process.env.GLINT_SOURCE_PUBLIC_DNS = "1";
  // @ts-expect-error JavaScript server exercised over actual HTTP.
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer() as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // 1) 真实 HTTPS 预览:正文提取。
    const preview = await fetch(`${base}/api/source/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: PUBLIC_URL }), signal: AbortSignal.timeout(40_000) });
    const previewBody = await preview.json() as { text?: string; error?: string };
    expect(preview.status, previewBody.error).toBe(200);
    expect(previewBody.text!.length).toBeGreaterThan(40);
    // 2) 产品作业链:正文 → 离线启发式工程 → 真实渲染。
    const submitted = await fetch(`${base}/api/make`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: previewBody.text, tts: "mock", aspect: "16:9" }), signal: AbortSignal.timeout(20_000) });
    const submitBody = await submitted.json() as { jobId?: string; error?: string };
    expect(submitted.status, submitBody.error).toBe(200);
    expect(submitBody.jobId).toMatch(/^[\w-]+$/);
    // 3) 轮询作业直至完成。
    const deadline = Date.now() + 300_000;
    let job: { status?: string; error?: string } = {};
    while (Date.now() < deadline) {
      job = await (await fetch(`${base}/api/make/${submitBody.jobId}`, { signal: AbortSignal.timeout(15_000) })).json();
      if (job.status === "done" || job.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(job.status, job.error).toBe("done");
    // 4) 下载成片:ffprobe 校验,抽帧确认非黑屏且有内容。
    const film = await fetch(`${base}/api/video/${submitBody.jobId}`, { signal: AbortSignal.timeout(30_000) });
    expect(film.status).toBe(200);
    const bytes = Buffer.from(await film.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(20_000);
    const filmPath = path.join(root, "film.mp4"); fs.writeFileSync(filmPath, bytes);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", filmPath], { encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(0);
    const streams = JSON.parse(probe.stdout).streams as Array<{ codec_type: string; codec_name: string; width: number }>;
    const video = streams.find(stream => stream.codec_type === "video");
    expect(video, "film must contain a video stream").toBeTruthy();
    const frame = path.join(root, "frame.png");
    const grab = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", filmPath, "-frames:v", "1", "-y", frame], { windowsHide: true });
    expect(grab.status).toBe(0);
    const raw = spawnSync("ffmpeg", ["-v", "error", "-i", frame, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 4_000_000, windowsHide: true });
    expect(raw.status).toBe(0);
    const pixels = raw.stdout as Buffer;
    const colors = new Set<number>();
    for (let offset = 0; offset + 2 < pixels.length; offset += 3) colors.add((pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!);
    expect(colors.size, "frame must not be a solid/black frame").toBeGreaterThan(16);
    if (process.env.GLINT_URL_FILM_EVIDENCE) {
      fs.mkdirSync(process.env.GLINT_URL_FILM_EVIDENCE, { recursive: true });
      fs.copyFileSync(filmPath, path.join(process.env.GLINT_URL_FILM_EVIDENCE, "url-film.mp4"));
      fs.copyFileSync(frame, path.join(process.env.GLINT_URL_FILM_EVIDENCE, "url-film-frame.png"));
      fs.writeFileSync(path.join(process.env.GLINT_URL_FILM_EVIDENCE, "source-text.txt"), previewBody.text!);
      fs.writeFileSync(path.join(process.env.GLINT_URL_FILM_EVIDENCE, "probe.json"), probe.stdout);
    }
    console.log("URL_FILM", JSON.stringify({ bytes: bytes.length, codec: video!.codec_name, width: video!.width, colors: colors.size, sourceChars: previewBody.text!.length }));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_DATA_DIR; else process.env.GLINT_DATA_DIR = previous;
    if (dns === undefined) delete process.env.GLINT_SOURCE_PUBLIC_DNS; else process.env.GLINT_SOURCE_PUBLIC_DNS = dns;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 420_000);
