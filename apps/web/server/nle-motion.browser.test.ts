import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { startDesktopService } from "./desktop-service.mjs";
type Page = Awaited<ReturnType<typeof openCaptureBrowser>>["page"];
const project = parseNleProject({
  schemaVersion: 1,
  id: "web-motion",
  title: "Web motion fixture",
  width: 320,
  height: 180,
  fps: 10,
  tracks: [
    {
      id: "v",
      kind: "video",
      name: "Video fixture",
      clips: [
        {
          id: "v1",
          kind: "video",
          src: "assets/footage.mp4",
          startMs: 0,
          durationMs: 400,
          volume: 0,
        },
      ],
    },
    {
      id: "t",
      kind: "text",
      name: "MG",
      clips: [
        {
          id: "t1",
          kind: "text",
          text: "MOVE",
          fontSize: 48,
          startMs: 0,
          durationMs: 400,
          keyframes: [
            { ms: 0, x: -0.4 },
            { ms: 400, x: 0.4 },
          ],
        },
      ],
    },
    {
      id: "a",
      kind: "audio",
      name: "Audio",
      clips: [{ id: "a1", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 400 }],
    },
  ],
});
function run(tool: string, args: string[]) {
  const result = spawnSync(tool, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  expect(result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}
function fixtures(root: string) {
  const media = path.join(root, "media");
  fs.mkdirSync(media);
  run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=60:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(media, "footage.mp4"),
  ]);
  run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "pcm_s16le",
    path.join(media, "tone.wav"),
  ]);
}
async function openProject(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.evaluate(
    (value) => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)),
    project,
  );
  await page.goto(url + "#/edit", { waitUntil: "networkidle0" });
  await page.waitForSelector('[aria-label="剪辑标题"]');
  expect(await page.$eval('[aria-label="剪辑标题"]', (el) => (el as HTMLInputElement).value)).toBe(
    project.title,
  );
}
async function captureWidths(page: Page) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 960, deviceScaleFactor: 1 });
    const sample = await page.$eval('[aria-label="子帧采样"]', (el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    expect(sample.left).toBeGreaterThanOrEqual(0);
    expect(sample.right).toBeLessThanOrEqual(width);
    expect(sample.width).toBeGreaterThan(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (process.env.GLINT_MOTION_WEB_EVIDENCE)
      await page.screenshot({
        path: path.join(process.env.GLINT_MOTION_WEB_EVIDENCE, `web-motion-${width}.png`),
      });
  }
}
async function render(page: Page, base: string, file: string, samples: number) {
  const response = page.waitForResponse(
    (reply) => reply.url().endsWith("/api/nle/render") && reply.request().method() === "POST",
  );
  await page.locator("button::-p-text(渲染 MP4)").click();
  const reply = await response,
    body = await reply.json();
  expect(reply.status(), JSON.stringify(body)).toBe(200);
  const request = JSON.parse(reply.request().postData()!);
  expect(request.motionSamples ?? 1).toBe(samples);
  if (samples > 1) expect(request.shutterAngle).toBe(360);
  const download = await fetch(base + body.url);
  expect(download.status).toBe(200);
  fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()));
  expect(fs.statSync(file).size).toBe(body.bytes);
  const probe = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,nb_frames,r_frame_rate",
      "-of",
      "json",
      file,
    ]).toString(),
  );
  expect(
    probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video"),
  ).toMatchObject({ width: 320, height: 180, nb_frames: "4", r_frame_rate: "10/1" });
  expect(
    probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"),
  ).toBe(true);
  await page.waitForFunction(() => document.body.textContent?.includes("成片已生成"));
  return probe;
}
function inspectOutputs(root: string, probes: unknown[]) {
  const decode = (name: string, audio: boolean) =>
    run("ffmpeg", [
      "-v",
      "error",
      "-i",
      path.join(root, name + ".mp4"),
      ...(audio ? ["-map", "0:a", "-f", "s16le"] : ["-f", "rawvideo", "-pix_fmt", "rgb24"]),
      "pipe:1",
    ]);
  expect(decode("motion", false)).not.toEqual(decode("default", false));
  expect(decode("motion", true)).toEqual(decode("default", true));
  const artifacts = ["default", "motion"].map((name) => {
    const bytes = fs.readFileSync(path.join(root, name + ".mp4"));
    if (process.env.GLINT_MOTION_WEB_EVIDENCE)
      fs.writeFileSync(path.join(process.env.GLINT_MOTION_WEB_EVIDENCE, name + ".mp4"), bytes);
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  console.log("WEB_MOTION", JSON.stringify({ probes, artifacts }));
}
function cleanup(root: string) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error("Unsafe fixture cleanup");
  fs.rmSync(root, { recursive: true, force: true });
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1")(
  "exports MG plus video with actual CLI subframes and keeps audio, responsive options and dock state",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-web-motion-"));
    let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
    let service: Awaited<ReturnType<typeof startDesktopService>> | undefined;
    try {
      fixtures(root);
      service = await startDesktopService({
        dataDir: root,
        distDir:
          process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)),
      });
      opened = await openCaptureBrowser(1440, 960);
      const page = opened.page;
      await openProject(page, service.url);
      const before = await page.evaluate(() => localStorage.getItem("glint.nle.project.v2"));
      const baseline = await render(page, service.url, path.join(root, "default.mp4"), 1);
      await page.locator(".nle-menu-wrap > summary::-p-text(导出)").click();
      await page.select('[aria-label="子帧采样"]', "4");
      await page.locator('[aria-label="快门角度"]').fill("360");
      await captureWidths(page);
      const motion = await render(page, service.url, path.join(root, "motion.mp4"), 4);
      expect(await page.evaluate(() => localStorage.getItem("glint.nle.project.v2"))).toBe(before);
      await page.locator("button::-p-text(收起时间线)").click();
      expect(await page.$('[aria-label="多轨时间线"]')).not.toBeNull();
      await page.locator("button::-p-text(展开时间线)").click();
      inspectOutputs(root, [baseline, motion]);
    } finally {
      await opened?.browser.close();
      await service?.close();
      cleanup(root);
    }
  },
  120_000,
);
