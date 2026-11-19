import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import type { ProjectContainer } from "@glintai/scenescript/project-container";
import { createWebServer } from "./index.mjs";
import { createProjectContainerStore } from "./project-container-session";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openInspector } from "./browser-workspace-helpers";

let available = false; try { findSystemBrowser(); available = true; } catch { /* Runner preflight requires a real browser. */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("creates one work from two source documents and edits both through shared durable history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-pair-browser-")), directory = path.join(root, "containers");
  const scene = { schemaVersion: 1, id: "original-scene", title: "Scene source", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "opening", kind: "title", title: "Original scene", narration: { text: "Fixture narration", durationMs: 2000 } }] };
  const timeline = { schemaVersion: 1, id: "original-timeline", title: "Original timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "caption", kind: "text", text: "Caption", startMs: 0, durationMs: 2000 }] }] };
  const sceneFile = path.join(root, "source-scene.json"), timelineFile = path.join(root, "source-timeline.json");
  fs.writeFileSync(sceneFile, JSON.stringify(scene)); fs.writeFileSync(timelineFile, JSON.stringify(timeline));
  const original = [fs.readFileSync(sceneFile), fs.readFileSync(timelineFile)], store = createProjectContainerStore(directory);
  const legacy = new FileSessionStore(path.join(root, "legacy"), value => { parseProject(value); });
  const server = createWebServer({ distDir: dist, sessionStore: legacy, projectContainerStoreFactory: () => store, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1440, 1000); const page = opened.page, errors: string[] = [], legacyOpens: string[] = []; let containerOpens = 0;
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { const route = new URL(request.url()).pathname; if (route === "/api/session/open") legacyOpens.push(request.url()); if (route === "/api/project-containers/open" && request.method() === "POST") containerOpens++; });
    const workspace = '[aria-label="统一作品"]';
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#/c`, { waitUntil: "networkidle0" });
    await page.select(`${workspace} fieldset select`, "paired");
    await (await page.$('input[aria-label="分镜文档 JSON"]'))!.uploadFile(sceneFile);
    await (await page.$('input[aria-label="剪辑文档 JSON"]'))!.uploadFile(timelineFile);
    await page.locator(`${workspace} input[type="checkbox"]`).click();
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (process.env.GLINT_UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
        await (await page.$(workspace))!.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `pair-import-${width}.png`) as `${string}.png` });
      }
    }
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    const opening = page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/open" && response.request().method() === "POST");
    await page.locator(`${workspace} button::-p-text(导入为新副本)`).click();
    const response = await opening; expect(response.status()).toBe(200);
    const saved = await response.json(), projectId = saved.snapshot.projectId as string, container = saved.snapshot.document as ProjectContainer;
    expect(container.objects).toHaveLength(2); expect(container.versions).toHaveLength(2);
    const sceneObject = container.objects.find(object => object.kind === "scene-document")!, timelineObject = container.objects.find(object => object.kind === "timeline-document")!;
    await page.waitForFunction(id => location.hash.includes(`/c/${id}`), {}, projectId); await openInspector(page);
    await page.waitForSelector('textarea[aria-label="title"]', { visible: true });
    expect(await page.$eval('textarea[aria-label="title"]', element => (element as HTMLTextAreaElement).value)).toBe("Original scene");
    const edit = async (selector: string, text: string, revision: number) => {
      const [result] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/append" && response.request().method() === "POST"),
        (async () => { await page.locator(selector).click(); await page.$eval(selector, element => (element as HTMLInputElement | HTMLTextAreaElement).select()); await page.keyboard.sendCharacter(text); })(),
      ]);
      expect(result.status()).toBe(200); expect(await result.json()).toMatchObject({ snapshot: { revision }, receipt: { stage: "verified" } });
      await page.waitForFunction((selector, revision) => [...document.querySelectorAll(`${selector} [role="status"]`)].some(element => element.textContent?.includes(`r${revision}`)), {}, workspace, revision);
    };
    await edit('textarea[aria-label="title"]', "Pair scene edit", 1);
    await page.select(`${workspace} > label select`, timelineObject.id);
    await page.waitForSelector('input[aria-label="剪辑标题"]', { visible: true });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="剪辑标题"]')?.value === "Original timeline");
    await edit('input[aria-label="剪辑标题"]', "Pair timeline edit", 2);
    const restarted = createProjectContainerStore(directory).snapshot(projectId), document = restarted.snapshot.document as unknown as ProjectContainer;
    expect(restarted.snapshot.revision).toBe(2); expect(document.versions).toHaveLength(4);
    for (const [objectId, originalId] of [[sceneObject.id, scene.id], [timelineObject.id, timeline.id]]) {
      const object = document.objects.find(item => item.id === objectId)!;
      expect((document.versions.find(version => version.id === object.currentVersionId)!.payload as { id: string }).id).toBe(originalId);
    }
    const listing = page.waitForResponse(result => new URL(result.url()).pathname === "/api/project-containers/list");
    await page.locator(`${workspace} a[href="#/c"]`).click();
    const listed = await listing; expect(listed.ok()).toBe(true);
    expect((await listed.json()).projects).toEqual(expect.arrayContaining([expect.objectContaining({ projectId, revision: 2, sceneCount: 1, timelineCount: 1, title: scene.title })]));
    await page.waitForSelector('section[aria-label="已有作品"] article.ws-row');
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (process.env.GLINT_UI_SCREENSHOT_DIR) await (await page.$('section[aria-label="已有作品"]'))!.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `project-list-${width}.png`) as `${string}.png` });
    }
    await page.locator('section[aria-label="已有作品"] button[aria-label="打开作品：Scene source"]').click();
    await page.waitForFunction(id => location.hash.includes(`/c/${id}`), {}, projectId); await openInspector(page);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')?.value === "Pair scene edit");
    expect(containerOpens).toBe(1);
    expect(fs.readFileSync(sceneFile)).toEqual(original[0]); expect(fs.readFileSync(timelineFile)).toEqual(original[1]);
    expect(legacy.list()).toEqual([]); expect(legacyOpens).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("glint.nle.")))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90_000);
