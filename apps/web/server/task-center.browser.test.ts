import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { createJobRunner } from "./jobs.mjs";
import { createTaskCenterReader } from "./task-center-read.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* Explicit opt-in never downloads browsers. */
}
type Capture = Awaited<ReturnType<typeof openCaptureBrowser>>;
type Fixture = {
  root: string;
  mediaDir: string;
  outputDir: string;
  renderStateDir: string;
  endpoint: string;
  origin: string;
  requests: string[];
  runner?: ReturnType<typeof createJobRunner>;
  server?: Server;
  opened?: Capture;
};
function fixturePaths(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-task-center-browser-"));
  const outputDir = path.join(root, "jobs");
  return {
    root,
    outputDir,
    mediaDir: path.join(root, "media"),
    renderStateDir: path.join(outputDir, ".jobs"),
    endpoint: "http://127.0.0.1:9",
    origin: "",
    requests: [],
  };
}
function seedFixture(fixture: Fixture) {
  const { mediaDir, renderStateDir, endpoint } = fixture;
  fs.mkdirSync(mediaDir);
  fs.mkdirSync(renderStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(mediaDir, "media-running.json"),
    JSON.stringify({
      taskId: "media-running",
      protocol: "skills",
      type: "image",
      state: "running",
      createdAt: new Date().toISOString(),
      cost: 0.25,
      prompt: "private fixture prompt",
    }),
  );
  fs.writeFileSync(
    path.join(mediaDir, "comfy-unconfirmed.json"),
    JSON.stringify({
      taskId: "comfy-unconfirmed",
      protocol: "comfyui",
      type: "image",
      state: "unconfirmed",
      endpointHash: createHash("sha256").update(endpoint).digest("hex"),
    }),
  );
  fs.writeFileSync(
    path.join(renderStateDir, "idea-recovered.json"),
    JSON.stringify({
      id: "idea-recovered",
      status: "failed",
      createdAt: Date.now(),
      log: ["failed"],
    }),
  );
}
async function startServer(fixture: Fixture) {
  const { root, mediaDir, renderStateDir, outputDir, endpoint } = fixture;
  const mediaJobs = createMediaJobs(mediaDir, { GLINT_COMFYUI_ENDPOINT: endpoint });
  fixture.runner = createJobRunner({ studioDir: root, outputDir });
  const reader = createTaskCenterReader({ mediaDir, renderStateDir });
  fixture.server = createWebServer({
    distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)),
    mediaJobs,
    makeRunner: fixture.runner,
    taskReader: reader,
    requestLogDir: path.join(root, "logs"),
  }) as Server;
  await new Promise<void>((resolve) => fixture.server!.listen(0, "127.0.0.1", resolve));
  fixture.origin = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`;
}
async function openPage(fixture: Fixture) {
  fixture.opened = await openCaptureBrowser(1440, 1000);
  const page = fixture.opened.page;
  const requests = fixture.requests;
  page.on("request", (request) =>
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`),
  );
  await page.goto(`${fixture.origin}/#/tasks`, { waitUntil: "networkidle0" });
}
const panel = 'section[aria-label="任务中心"]',
  media = `${panel} article[aria-label="媒体生成 media-running"]`,
  comfy = `${panel} article[aria-label="本地工作流 comfy-unconfirmed"]`;

async function exerciseMedia(fixture: Fixture) {
  const page = fixture.opened!.page,
    { requests, mediaDir } = fixture;
  await page.waitForSelector(media);
  expect(await page.$eval(panel, (node) => node.textContent)).toContain("单位未知");
  expect(await page.$eval(panel, (node) => node.textContent)).not.toContain(
    "private fixture prompt",
  );
  await page.locator(`${media} ::-p-text(取消任务)`).click();
  expect(requests.some((request) => request === "POST /api/media/cancel/media-running")).toBe(
    false,
  );
  await page.locator(`${media} ::-p-text(确认取消)`).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="任务中心"]')?.textContent?.includes("取消请求已发出"),
  );
  expect(
    requests.filter((request) => request === "POST /api/media/cancel/media-running"),
  ).toHaveLength(1);
  await page.locator(`${media} ::-p-text(恢复状态)`).click();
  await page.waitForFunction(() =>
    document
      .querySelector('article[aria-label="媒体生成 media-running"]')
      ?.textContent?.includes("已取消本地任务"),
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(mediaDir, "media-running.json"), "utf8")).cancelled,
  ).toBe(true);
}
async function exerciseComfy(fixture: Fixture) {
  const page = fixture.opened!.page;
  await page.locator(`${comfy} ::-p-text(取消任务)`).click();
  await page.locator(`${comfy} ::-p-text(确认取消)`).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="任务中心"]')?.textContent?.includes("未确认停止"),
  );
  expect(await page.$eval(comfy, (node) => node.textContent)).toContain("提交未确认");
}
async function assertRestored(fixture: Fixture) {
  const page = fixture.opened!.page,
    { requests, origin } = fixture;
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() =>
    document
      .querySelector('article[aria-label="媒体生成 media-running"]')
      ?.textContent?.includes("已取消本地任务"),
  );
  expect(
    requests.filter((request) => /POST \/api\/(media\/(?:comfyui\/)?submit|make)$/.test(request)),
  ).toEqual([]);
  expect((await (await fetch(`${origin}/api/tasks`)).json()).tasks).toHaveLength(3);
}
async function captureWidths(fixture: Fixture) {
  const page = fixture.opened!.page;
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    const region = await page.$(panel),
      box = await region!.boundingBox();
    expect(box && box.width <= width).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (process.env.GLINT_UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
      await region!.screenshot({
        path: path.join(
          process.env.GLINT_UI_SCREENSHOT_DIR,
          `task-center-${width}.png`,
        ) as `${string}.png`,
      });
    }
  }
}
async function cleanup(fixture: Fixture) {
  const { opened, runner, server, root } = fixture;
  await opened?.browser.close();
  runner?.dispose();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true });
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "recovers and cancels persisted tasks through existing HTTP services at three widths",
  async () => {
    const fixture = fixturePaths();
    try {
      seedFixture(fixture);
      await startServer(fixture);
      await openPage(fixture);
      await exerciseMedia(fixture);
      await exerciseComfy(fixture);
      await assertRestored(fixture);
      await captureWidths(fixture);
    } finally {
      await cleanup(fixture);
    }
  },
  60000,
);
