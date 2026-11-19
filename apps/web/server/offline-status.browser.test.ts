import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openInspector } from "./browser-workspace-helpers";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("keeps install, update and offline notices in flow while authoring and navigation remain reachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-offline-flow-"));
  let server: Server | undefined, opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    const store = createProjectContainerStore(path.join(root, "containers"));
    const { container } = await migrateDocumentToContainer({ schemaVersion: 1, id: "scene-source", title: "Fixture", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "s", kind: "title", title: "原始标题", narration: { text: "Text", durationMs: 1000 } }] }, { kind: "scene-document", projectId: "offline-flow", objectId: "scene", versionId: "v1", actor: "user", transactionId: "import" });
    server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), projectContainerStoreFactory: () => store, requestLogDir: path.join(root, "logs") }) as Server;
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${origin}/api/project-containers/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: container.id, project: container, createOnly: true }) })).status).toBe(200);
    opened = await openCaptureBrowser(1440, 1000); const page = opened.page;
    await page.evaluateOnNewDocument(() => {
      const worker = { postMessage: () => { document.documentElement.dataset.activated = "yes"; } };
      const installing = new EventTarget(), registration = Object.assign(new EventTarget(), { waiting: null as typeof worker | null, installing });
      const serviceWorker = Object.assign(new EventTarget(), { controller: {}, register: async () => registration });
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
      window.addEventListener("fixture:show", () => {
        const install = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => { document.documentElement.dataset.installed = "yes"; } });
        window.dispatchEvent(install); registration.waiting = worker; registration.dispatchEvent(new Event("updatefound")); installing.dispatchEvent(new Event("statechange")); window.dispatchEvent(new Event("offline"));
      });
    });
    await page.goto(`${origin}/#/c/offline-flow/scene`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="保存状态"]'); await openInspector(page);
    const unblocked = async (selector: string) => {
      await page.$eval(selector, element => element.scrollIntoView({ block: "center" }));
      expect(await page.$eval(selector, element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return Boolean(hit && (element === hit || element.contains(hit))); })).toBe(true);
    };
    await unblocked('[aria-label="保存状态"] button');
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:show")));
      await page.waitForSelector('[aria-label="连接与应用状态"]');
      expect(await page.$eval('.offline-status', element => getComputedStyle(element).position)).toBe("static");
      expect(await page.evaluate(() => { const status = document.querySelector('.offline-status')!.getBoundingClientRect(), main = document.querySelector('#app-main')!.getBoundingClientRect(); return status.bottom <= main.top; })).toBe(true);
      await unblocked('[aria-label="保存状态"] button'); await unblocked('[aria-label="设置"]');
      expect(await page.$eval('.offline-status', element => element.textContent)).toContain("安装 Glint");
      expect(await page.$eval('.offline-status', element => element.textContent)).toContain("有新版本");
      if (process.env.GLINT_UI_SCREENSHOT_DIR) { fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `offline-flow-${width}.png`) as `${string}.png` }); }
    }
    // Real editor autosave while the status bar is visible.
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 }); await openInspector(page);
    const title = 'textarea[aria-label="title"]';
    await page.locator(title).click(); await page.$eval(title, element => (element as HTMLTextAreaElement).select());
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/append" && response.request().method() === "POST");
    await page.keyboard.sendCharacter("状态条下保存"); expect((await saved).status()).toBe(200);
    page.once("dialog", dialog => void dialog.dismiss()); await page.locator('.offline-status button::-p-text(重新加载)').click();
    expect(await page.evaluate(() => document.documentElement.dataset.activated)).toBeUndefined();
    await page.locator('.offline-status button::-p-text(安装 Glint)').click(); expect(await page.evaluate(() => document.documentElement.dataset.installed)).toBe("yes");
    await page.locator('.offline-status button::-p-text(稍后更新)').click(); await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => !document.querySelector('.offline-status'));
    await page.locator('[aria-label="设置"]').click(); await page.waitForSelector('[aria-label="模型连接设置"]');
  } finally {
    await opened?.browser.close(); if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected cleanup path"); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
