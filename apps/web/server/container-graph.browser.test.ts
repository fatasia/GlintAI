import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import {
  appendProjectVersions,
  migrateDocumentToContainer,
  parseProjectContainer,
  projectContentDigest,
} from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
type Page = Awaited<ReturnType<typeof openCaptureBrowser>>["page"];

let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* No browser downloads. */
}
const projectId = "graph-browser";
const scene = parseProject({
  schemaVersion: 1,
  id: "scene-source",
  title: "原分镜",
  aspect: "16:9",
  knowledgeSources: [],
  scenes: [
    {
      id: "one",
      kind: "title",
      title: "开场",
      narration: { text: "图谱测试", durationMs: 1000 },
    },
  ],
});
const timeline = {
  schemaVersion: 1,
  id: "timeline-source",
  title: "剪辑文档",
  width: 1280,
  height: 720,
  fps: 30,
  tracks: [
    {
      id: "text",
      kind: "text",
      name: "字幕",
      clips: [{ id: "caption", kind: "text", text: "字幕", startMs: 0, durationMs: 1000 }],
    },
  ],
};
async function fixture() {
  const options = { projectId, actor: "user", transactionId: "import" };
  const first = await migrateDocumentToContainer(scene, {
    ...options,
    kind: "scene-document",
    objectId: "scene",
    versionId: "scene-v1",
  });
  const second = await migrateDocumentToContainer(timeline, {
    ...options,
    kind: "timeline-document",
    objectId: "timeline",
    versionId: "timeline-v1",
  });
  const work = await parseProjectContainer({
    ...first.container,
    objects: [...first.container.objects, ...second.container.objects],
    versions: [...first.container.versions, ...second.container.versions],
  });
  const newer = { ...scene, title: "新版分镜" };
  return appendProjectVersions(work, {
    versions: [
      {
        id: "scene-v2",
        objectId: "scene",
        parentVersionId: "scene-v1",
        actor: "user",
        transactionId: "prepare",
        sources: [],
        references: [],
        payload: newer,
        contentDigest: await projectContentDigest(newer),
      },
      {
        id: "timeline-v2",
        objectId: "timeline",
        parentVersionId: "timeline-v1",
        actor: "user",
        transactionId: "prepare",
        sources: [{ objectId: "scene", versionId: "scene-v1" }],
        references: [],
        payload: timeline,
        contentDigest: await projectContentDigest(timeline),
      },
    ],
    current: [
      { objectId: "scene", versionId: "scene-v2" },
      { objectId: "timeline", versionId: "timeline-v2" },
    ],
  });
}
async function inspectGraph(page: Page, screenshots: string) {
  await page.click(".work-graph > summary");
  await page.waitForSelector(".work-graph-card", { visible: true });
  expect(await page.$$eval(".work-graph-card", (nodes) => nodes.length)).toBe(3);
  await page.click('.work-graph-card[data-current="false"] button');
  expect(await page.$eval(".work-graph-selection", (node) => node.textContent)).toContain(
    "引用的历史版本",
  );
  expect(await page.$(".work-graph-selection button")).toBeNull();
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 980 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(screenshots, `work-graph-${width}.png`) });
  }
  await page.setViewport({ width: 1440, height: 980 });
  await page.click('.work-graph-card[data-current="true"] button[aria-label="选择对象 timeline"]');
  await page.click(".work-graph-selection button");
  await page.waitForSelector('input[aria-label="剪辑标题"]', { visible: true });
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[aria-label="剪辑标题"]')?.value ===
      "剪辑文档",
  );
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "opens exact saved work documents from the shared canvas without changing history",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-work-graph-"));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected cleanup target");
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
      const page = opened.page,
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/#/c/${projectId}/scene`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".work-graph > summary", { visible: true });
      const screenshots = process.env.GLINT_UI_SCREENSHOT_DIR ?? root;
      fs.mkdirSync(screenshots, { recursive: true });
      await inspectGraph(page, screenshots);
      expect(store.snapshot(projectId).snapshot.revision).toBe(0);
      expect(
        (store.snapshot(projectId).snapshot.document.versions.at(-2)?.payload as SceneScriptProject)
          .title,
      ).toBe("新版分镜");
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
