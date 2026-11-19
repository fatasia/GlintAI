import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "puppeteer-core";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { parsePrevizDocument } from "../../../packages/previz/src/index";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openRestoredProject } from "./browser-workspace-helpers";
import { preparePrevizDownload } from "./previz-download-test-helper";
const SCRIPT = "第一场 茶馆 内 日\n老陈：新茶到了。\n小满：我来尝尝。";
let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* No browser downloads. */
}
async function saveScreenplay(page: Page) {
  await page.waitForSelector('[aria-label="脚本文档正文"]', { visible: true });
  await page.$eval(
    '[aria-label="脚本文档正文"]',
    (element, text) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        element,
        text,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    },
    SCRIPT,
  );
  await page.locator(".script-editor button::-p-text(保存)").click();
  await page.waitForFunction(
    (text) => {
      if (document.querySelector(".script-save-status")?.textContent !== "已保存到本机")
        return false;
      return Object.keys(localStorage)
        .filter((key) => key.startsWith("glint.project-documents.v1:"))
        .some((key) => {
          const saved = JSON.parse(localStorage.getItem(key)!);
          return saved.documents.some(
            (doc: { kind: string; content: string }) =>
              doc.kind === "screenplay" && doc.content === text,
          );
        });
    },
    {},
    SCRIPT,
  );
}
async function openStoryboard(page: Page, origin: string) {
  const runtime = await fetch(`${origin}/three.runtime.js`);
  expect(runtime.status).toBe(200);
  expect(runtime.headers.get("content-type")).toContain("javascript");
  expect((await runtime.text()).length).toBeGreaterThan(1000);
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.locator('[aria-label="创作类型"] button::-p-text(视频创作)').click();
  await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
  await page
    .locator('textarea[aria-label="快速成片资料"]')
    .fill("# 茶馆\n\n- 新茶到了\n- 来尝尝茶\n\n一次茶馆对话。");
  await page.locator(".pc-submit").click();
  await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"]')), {
    timeout: 30000,
  });
  await openRestoredProject(page);
  await page.locator(".glint-view-switch button::-p-text(脚本)").click();
  await page.locator(".script-editor button::-p-text(新建)").click();
  await page.select('[aria-label="新文档类型"]', "screenplay");
  await page.$eval('[aria-label="文档名称"]', (element) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      element,
      "预演测试",
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval("form", (form) =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await saveScreenplay(page);
  await page.locator(".glint-view-switch button::-p-text(分镜)").click();
  await page.locator('[aria-label="默认渲染方式"] button::-p-text(MG 动态图形)').click();
  await page.locator(".storyboard-table button::-p-text(几何预演)").click();
  await page.waitForSelector(".storyboard-previz", { visible: true });
}
async function renderedFrame(page: Page) {
  await page.waitForSelector(".previz-preview iframe", { visible: true });
  const element = await page.$(".previz-preview iframe"),
    wrapper = await element!.contentFrame();
  if (!wrapper) throw new Error("Preview wrapper unavailable");
  await wrapper.waitForSelector("#glint-document");
  const child = await wrapper.$("#glint-document"),
    frame = await child!.contentFrame();
  if (!frame) throw new Error("Preview frame unavailable");
  await frame.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas && canvas.toDataURL().length > 1000;
  });
  const pixels = await frame.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const sample = document.createElement("canvas");
    sample.width = canvas.width;
    sample.height = canvas.height;
    const context = sample.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const rgba = context.getImageData(0, 0, sample.width, sample.height).data;
    let colored = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if (rgba[i]! + rgba[i + 1]! + rgba[i + 2]! > 30) colored++;
    return {
      width: canvas.width,
      height: canvas.height,
      viewport: [innerWidth, innerHeight],
      colored,
      url: canvas.toDataURL(),
    };
  });
  expect([pixels.width, pixels.height]).toEqual(pixels.viewport);
  expect(pixels.colored).toBeGreaterThan(100);
  return pixels.url;
}
async function changeCamera(page: Page, evidence: string) {
  const before = await renderedFrame(page);
  await page.screenshot({ path: path.join(evidence, "before.png") });
  await page.locator('input[aria-label="相机 X 位置（米）"]').fill("3");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[aria-label="相机 X 位置（米）"]')?.value ===
      "3",
  );
  const after = await renderedFrame(page);
  expect(after).not.toBe(before);
  await page.locator(".glint-view-switch button::-p-text(作品)").click();
  expect(await page.$(".storyboard-previz")).not.toBeNull();
  expect(await page.$eval("body", (node) => node.textContent)).toContain("未导出的预演草稿");
  await page.locator(".storyboard-table button::-p-text(几何预演)").click();
  expect(
    await page.$eval(
      'input[aria-label="相机 X 位置（米）"]',
      (node) => (node as HTMLInputElement).value,
    ),
  ).toBe("3");
}
async function exportAndRestore(page: Page, evidence: string) {
  const { client, done } = await preparePrevizDownload(page, evidence);
  await page.locator(".storyboard-previz button::-p-text(导出预演 JSON)").click();
  await done;
  await page.waitForFunction(() => document.body.textContent?.includes("我已确认 JSON 保存成功"));
  await page.locator(".glint-view-switch button::-p-text(作品)").click();
  expect(await page.$(".storyboard-previz")).not.toBeNull();
  await page.locator(".storyboard-previz button::-p-text(我已确认 JSON 保存成功)").click();
  await page.locator(".storyboard-previz button::-p-text(关闭预演)").click();
  expect(await page.$(".storyboard-previz")).toBeNull();
  await page.locator(".storyboard-table button::-p-text(几何预演)").click();
  await page.waitForSelector('.storyboard-previz input[type="file"]');
  const names = fs.readdirSync(evidence).filter((name) => name.endsWith(".previz.json"));
  expect(names).toHaveLength(1);
  const file = path.join(evidence, names[0]!);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(doc.cameras[0].keys[0].position[0]).toBe(3);
  await (await page.$('.storyboard-previz input[type="file"]'))!.uploadFile(file);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[aria-label="相机 X 位置（米）"]')?.value ===
      "3",
  );
  await client.detach();
}
async function screenshots(page: Page, evidence: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 1000 });
    await renderedFrame(page);
    await page.$eval(".storyboard-previz", (element) => element.scrollIntoView({ block: "start" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const panel = await page.$(".storyboard-previz");
    await panel!.screenshot({ path: path.join(evidence, `previz-${width}.png`) });
  }
}
async function motionControls(page: Page, evidence: string) {
  const originalName = fs.readdirSync(evidence).find((name) => name.endsWith(".previz.json"))!;
  const original = fs.readFileSync(path.join(evidence, originalName), "utf8");
  await page.locator(".storyboard-previz button::-p-text(迁移为动作新副本)").click();
  await page.locator(".storyboard-previz button::-p-text(在当前帧添加动作)").click();
  await page.select('[aria-label="姿势"]', "walk");
  const before = await renderedFrame(page);
  await page.$eval('[aria-label="镜头帧"]', (element) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "12");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".storyboard-previz button::-p-text(在当前帧添加动作)").click();
  await page.select('[aria-label="动作关键帧"]', "1");
  await page.locator('input[aria-label="人偶 X 位置（米）"]').fill("2");
  await page.locator('input[aria-label="步态周期（0–1000）"]').fill("1");
  await page.locator(".storyboard-previz button::-p-text(在当前帧添加机位)").click();
  await page.select('[aria-label="相机关键帧"]', "1");
  await page.locator('input[aria-label="相机 X 位置（米）"]').fill("4");
  const later = await renderedFrame(page);
  expect(later).not.toBe(before);
  const { client, done } = await preparePrevizDownload(page, evidence);
  await page.locator(".storyboard-previz button::-p-text(导出预演 JSON)").click();
  await done;
  await page.locator(".storyboard-previz button::-p-text(我已确认 JSON 保存成功)").click();
  const names = fs
    .readdirSync(evidence)
    .filter((name) => name.endsWith(".previz.json") && name !== originalName);
  expect(names).toHaveLength(1);
  const doc = parsePrevizDocument(
    JSON.parse(fs.readFileSync(path.join(evidence, names[0]!), "utf8")),
  );
  expect(doc.schemaVersion).toBe(2);
  if (doc.schemaVersion !== 2) throw new Error("motion copy missing");
  expect(doc.actorTracks[0]!.keys).toHaveLength(2);
  expect(doc.actorTracks[0]!.keys[1]!.position[0]).toBe(2);
  expect(doc.cameras[0]!.keys).toHaveLength(2);
  expect(fs.readFileSync(path.join(evidence, originalName), "utf8")).toBe(original);
  await client.detach();
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "opens each shot's geometry, changes actual camera pixels, guards drafts and restores exported JSON",
  async () => {
    const root = process.env.GLINT_DATA_DIR;
    if (!root || !process.env.GLINT_SESSION_DIR)
      throw new Error("Isolated task directories required");
    const evidence =
      process.env.GLINT_UI_SCREENSHOT_DIR ??
      fs.mkdtempSync(path.join(os.tmpdir(), "previz-browser-evidence-"));
    fs.mkdirSync(evidence, { recursive: true });
    const { createWebServer } = await import("./index.mjs");
    const server = createWebServer({
      distDir:
        process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)),
      sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, (value) => {
        parseProject(value);
      }),
    }) as Server;
    let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      opened = await openCaptureBrowser(1440, 1000);
      const errors: string[] = [];
      opened.page.on("pageerror", (error) => errors.push(String(error)));
      await openStoryboard(
        opened.page,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
      await changeCamera(opened.page, evidence);
      await exportAndRestore(opened.page, evidence);
      await motionControls(opened.page, evidence);
      await screenshots(opened.page, evidence);
      expect(errors).toEqual([]);
      console.log(JSON.stringify({ evidence }));
    } catch (error) {
      if (opened) {
        console.log(
          JSON.stringify({
            diagnostic: await opened.page.evaluate(() => ({
              text: document.body.innerText.slice(0, 12000),
              alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
                (node) => node.textContent,
              ),
            })),
          }),
        );
        await opened.page.screenshot({ path: path.join(evidence, "failure.png") });
      }
      throw error;
    } finally {
      await opened?.browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  60000,
);
