import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "puppeteer-core";
import { expect, it } from "vitest";
import {
  migrateDocumentToContainer,
  parseProjectContainer,
} from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* No browser downloads. */
}
const projectId = "timeline-dock-browser";
const scene = {
  schemaVersion: 1,
  id: "scene-source",
  title: "工作台剪辑",
  aspect: "16:9",
  knowledgeSources: [],
  scenes: [
    {
      id: "one",
      kind: "title",
      title: "开场",
      narration: { text: "开场说明", durationMs: 1000 },
    },
    {
      id: "two",
      kind: "title",
      title: "内容",
      narration: { text: "内容说明", durationMs: 2000 },
    },
  ],
};
const timeline = {
  schemaVersion: 1,
  id: "timeline-source",
  title: "多轨工作台",
  fps: 30,
  width: 1280,
  height: 720,
  tracks: [
    {
      id: "text",
      kind: "text",
      name: "字幕",
      clips: [{ id: "caption", kind: "text", text: "工作台字幕", startMs: 0, durationMs: 2000 }],
    },
  ],
};
async function fixture() {
  const options = { projectId, actor: "user", transactionId: "import" };
  const a = (
    await migrateDocumentToContainer(scene, {
      ...options,
      kind: "scene-document",
      objectId: "scene",
      versionId: "scene-v1",
    })
  ).container;
  const b = (
    await migrateDocumentToContainer(timeline, {
      ...options,
      kind: "timeline-document",
      objectId: "timeline",
      versionId: "timeline-v1",
    })
  ).container;
  return parseProjectContainer({
    ...a,
    objects: [...a.objects, ...b.objects],
    versions: [...a.versions, ...b.versions],
  });
}
async function inspect(page: Page, origin: string, kind: "scene" | "timeline", screens: string) {
  await page.goto(`${origin}/#/c/${projectId}/${kind}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".timeline-dock__toggle", { visible: true });
  expect(
    await page.$eval(".timeline-dock__toggle", (node) => node.getAttribute("aria-expanded")),
  ).toBe("true");
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 980 });
    await page.$eval(".timeline-dock", (node) => node.scrollIntoView({ block: "end" }));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: path.join(screens, `${kind}-${width}.png`) });
  }
  await page.setViewport({ width: 1440, height: 980 });
  const retained = await page.$(".timeline-dock__body > *");
  await page.click(".timeline-dock__toggle");
  expect(await page.$eval(".timeline-dock__body", (node) => (node as HTMLElement).hidden)).toBe(
    true,
  );
  expect(await retained!.evaluate((node) => node.isConnected)).toBe(true);
  expect(
    await page.$eval(".timeline-dock", (node) => node.getBoundingClientRect().height),
  ).toBeLessThan(85);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".timeline-dock__toggle", { visible: true });
  expect(
    await page.$eval(".timeline-dock__toggle", (node) => node.getAttribute("aria-expanded")),
  ).toBe("false");
  await page.click(".timeline-dock__toggle");
  expect(await page.$eval(".timeline-dock__body", (node) => (node as HTMLElement).hidden)).toBe(
    false,
  );
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "folds both real timeline docks without editing shared history at three widths",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-timeline-dock-"));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected cleanup root");
    const store = createProjectContainerStore(path.join(root, "containers"));
    store.open(projectId, await fixture(), undefined, true);
    const server = createWebServer({
      projectContainerStoreFactory: () => store,
      distDir:
        process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)),
      requestLogDir: path.join(root, "logs"),
    }) as Server;
    let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      opened = await openCaptureBrowser(1440, 980);
      const screens = process.env.GLINT_UI_SCREENSHOT_DIR ?? root;
      fs.mkdirSync(screens, { recursive: true });
      const errors: string[] = [];
      opened.page.on("pageerror", (error) => errors.push(String(error)));
      await inspect(opened.page, origin, "scene", screens);
      await inspect(opened.page, origin, "timeline", screens);
      expect(store.snapshot(projectId).snapshot.revision).toBe(0);
      expect(store.snapshot(projectId).look.undoDepth).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await opened?.browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  45000,
);
