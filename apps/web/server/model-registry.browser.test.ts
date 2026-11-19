import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createWebServer } from "./index.mjs";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createLlmSettings } from "./llm-settings.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { registryTemplate } from "../src/model-registry-data";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* Opt-in runner requires an installed browser. */
}
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const panel = 'section[aria-label="模型注册表"]';
type Page = Awaited<ReturnType<typeof openCaptureBrowser>>["page"];
async function selectRegistry(page: Page) {
  await page.locator('[role="tab"]::-p-text(模型注册表)').click();
  await page.waitForSelector(panel, { visible: true });
}
async function importAndSave(page: Page, input: string, text: string) {
  const file = await page.$(`${panel} input[type="file"]`);
  await file!.uploadFile(input);
  await page.waitForFunction(
    (selector, expected) =>
      document.querySelector<HTMLTextAreaElement>(`${selector} textarea`)?.value === expected,
    {},
    panel,
    text,
  );
  await page.locator(`${panel} button::-p-text(检查导入内容)`).click();
  await page.waitForSelector(`${panel} input[type="checkbox"]`);
  await page.locator('[role="tab"]::-p-text(API 模型)').click();
  await selectRegistry(page);
  expect(await page.$eval(`${panel} textarea`, (node) => (node as HTMLTextAreaElement).value)).toBe(
    text,
  );
  expect(
    await page.$eval(
      `${panel} button.g-button--primary`,
      (node) => (node as HTMLButtonElement).disabled,
    ),
  ).toBe(true);
  await page.click(`${panel} input[type="checkbox"]`);
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === "/api/settings/model-registry" &&
      value.request().method() === "PUT",
  );
  await page.locator(`${panel} button::-p-text(替换并保存)`).click();
  expect((await response).status()).toBe(200);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent?.includes("已保存到本机配置目录"),
    {},
    panel,
  );
}
async function captureWidths(page: Page) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    const element = await page.$(panel),
      box = await element!.boundingBox();
    expect(box && box.width <= width).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.$eval(`${panel} header`, (node) => node.scrollIntoView({ block: "start" }));
    if (process.env.GLINT_UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.GLINT_UI_SCREENSHOT_DIR,
          `model-registry-${width}.png`,
        ) as `${string}.png`,
        fullPage: true,
      });
      await page.$eval(`${panel} button.g-button--primary`, (node) =>
        node.scrollIntoView({ block: "center" }),
      );
      expect(
        await page.$eval(`${panel} button.g-button--primary`, (node) => {
          const box = node.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            node.contains(
              document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
            )
          );
        }),
      ).toBe(true);
      await page.screenshot({
        path: path.join(
          process.env.GLINT_UI_SCREENSHOT_DIR,
          `model-registry-${width}-confirm.png`,
        ) as `${string}.png`,
        fullPage: true,
      });
    }
  }
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "imports the registry through settings, retains tab drafts and restores saved rows at three widths",
  async () => {
    if (!fs.existsSync(path.join(dist, "index.html")))
      throw new Error("Build Web before registry browser verification");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-browser-"));
    let server: Server | undefined,
      opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
    try {
      const store = createModelRegistryStore(path.join(root, "registry.json"));
      server = createWebServer({
        distDir: dist,
        modelRegistryStore: store,
        llmSettings: createLlmSettings({}),
        mediaSettings: createMediaSettings({ env: {} }),
        requestLogDir: path.join(root, "logs"),
      }) as Server;
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const models = registryTemplate();
      models[0]!.name = "注册表示例图像";
      const text = JSON.stringify({ models }),
        input = path.join(root, "registry-import.json");
      fs.writeFileSync(input, text);
      opened = await openCaptureBrowser(1440, 1000);
      const page = opened.page,
        errors: string[] = [],
        mutations: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("request", (request) => {
        if (["POST", "PUT", "DELETE"].includes(request.method()))
          mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      });
      await page.goto(`${origin}/#/settings`, { waitUntil: "networkidle0" });
      await selectRegistry(page);
      await importAndSave(page, input, text);
      expect((await store.read()).models).toEqual(models);
      await captureWidths(page);
      await page.reload({ waitUntil: "networkidle0" });
      await selectRegistry(page);
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent?.includes("注册表示例图像"),
        {},
        panel,
      );
      expect(await page.$eval(panel, (node) => node.textContent)).toContain("仅注册 · 未接执行");
      expect(await page.$eval(panel, (node) => node.textContent)).toContain("价格未知");
      expect(
        await page.$eval(`${panel} textarea`, (node) => (node as HTMLTextAreaElement).value),
      ).toBe("");
      expect(mutations).toEqual(["PUT /api/settings/model-registry"]);
      expect(errors).toEqual([]);
    } finally {
      await opened?.browser.close();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
