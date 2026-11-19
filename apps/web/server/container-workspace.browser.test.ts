import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { migrateDocumentToContainer, parseProjectContainer, type ProjectContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openInspector } from "./browser-workspace-helpers";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let available = false; try { findSystemBrowser(); available = true; } catch { /* No implicit downloads. */ }
const projectId = "container-browser", sceneObject = "scene-doc", nleObject = "nle-doc";
const sceneTitle = "原分镜标题", changedSceneTitle = "共享分镜修改";
const nleTitle = "原剪辑标题", changedNleTitle = "共享剪辑修改";

async function fixture() {
  const scene = { schemaVersion: 1, id: "scene-document", title: "分镜作品", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "opening", kind: "title", title: sceneTitle, narration: { text: "本地测试旁白", durationMs: 2000 } }] };
  const timeline = { schemaVersion: 1, id: "timeline-document", title: nleTitle, fps: 30, width: 1280, height: 720,
    tracks: [{ id: "text", kind: "text", name: "字幕", clips: [{ id: "caption", kind: "text", text: "本地可编辑字幕", startMs: 0, durationMs: 2000 }] }] };
  const a = (await migrateDocumentToContainer(scene, { kind: "scene-document", projectId, objectId: sceneObject, versionId: "scene-v1", actor: "user", transactionId: "import" })).container;
  const b = (await migrateDocumentToContainer(timeline, { kind: "timeline-document", projectId, objectId: nleObject, versionId: "nle-v1", actor: "user", transactionId: "import" })).container;
  return parseProjectContainer({ ...a, objects: [...a.objects, ...b.objects], versions: [...a.versions, ...b.versions] });
}

function projection(store: FileSessionStore, objectId: string) {
  const container = store.snapshot(projectId).snapshot.document as unknown as ProjectContainer;
  const object = container.objects.find(item => item.id === objectId)!;
  return container.versions.find(version => version.id === object.currentVersionId)!.payload as { title: string; scenes?: Array<{ title: string }> };
}

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("shares persistent container history across scene and NLE views without opening legacy stores", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the Web app before container browser verification");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-browser-")), directory = path.join(root, "containers");
  const store = createProjectContainerStore(directory), legacy = new FileSessionStore(path.join(root, "legacy"), document => { parseProject(document); });
  const server = createWebServer({ distDir: dist, sessionStore: legacy, projectContainerStoreFactory: () => store, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/project-containers/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, project: await fixture(), createOnly: true }) });
    expect(response.status).toBe(200); expect((await response.json()).snapshot.revision).toBe(0);
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [], requests: string[] = [], legacyWrites: string[] = [];
    const revisions: unknown[] = [];
    page.on("response", response => {
      if (new URL(response.url()).pathname.startsWith("/api/project-containers/")) void response.json().then(body => revisions.push({ route: new URL(response.url()).pathname, status: response.status(), revision: body.snapshot?.revision, stage: body.receipt?.stage })).catch(() => undefined);
    });
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { const url = new URL(request.url()); if (url.protocol.startsWith("http")) requests.push(url.pathname); });
    page.on("console", message => { if (message.text().startsWith("legacy-nle-write:")) legacyWrites.push(message.text()); });
    await page.evaluateOnNewDocument(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string) {
        if (this === localStorage && key.startsWith("glint.nle.")) console.debug(`legacy-nle-write:${key}`);
        return original.call(this, key, value);
      };
    });
    const workspace = '[aria-label="统一作品"]';
    // One browser paste is one edit. Locator.fill types CJK character-by-character,
    // producing several legitimate autosave transactions, not one undo step.
    const paste = async (selector: string, text: string) => {
      await page.locator(selector).click();
      await page.$eval(selector, element => (element as HTMLInputElement | HTMLTextAreaElement).select());
      await page.keyboard.sendCharacter(text);
    };
    const mutation = async (action: "append" | "undo" | "redo", run: () => Promise<unknown>, revision: number) => {
      const receipt = page.waitForResponse(result => new URL(result.url()).pathname === `/api/project-containers/${action}` && result.request().method() === "POST");
      const [result] = await Promise.all([receipt, run()]);
      expect(result.status()).toBe(200);
      const body = await result.json(); expect(body.receipt.stage).toBe("verified"); expect(body.snapshot.revision).toBe(revision);
      try { await page.waitForFunction((r, selector) => [...document.querySelectorAll(`${selector} [role="status"]`)].some(element => element.textContent?.includes(`r${r}`)), {}, revision, workspace); }
      catch (error) {
        console.error("Container mutation diagnostic", JSON.stringify({ action, revision, revisions, requests, errors, savedRevision: store.snapshot(projectId).snapshot.revision, dom: await page.evaluate(() => ({ statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent), alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent), title: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')?.value, sections: [...document.querySelectorAll('section[aria-label]')].map(element => element.getAttribute("aria-label")) })) }));
        throw error;
      }
      expect(store.snapshot(projectId).snapshot.revision).toBe(revision);
    };
    await page.goto(`${origin}/#/c/${projectId}/${sceneObject}`, { waitUntil: "networkidle0" });
    await openInspector(page);
    await page.waitForSelector('textarea[aria-label="title"]', { visible: true });
    expect(await page.$eval('textarea[aria-label="title"]', element => (element as HTMLTextAreaElement).value)).toBe(sceneTitle);
    await mutation("append", () => paste('textarea[aria-label="title"]', changedSceneTitle), 1);
    expect(projection(store, sceneObject).scenes?.[0]!.title).toBe(changedSceneTitle);
    await page.select(`${workspace} select`, nleObject);
    await page.waitForSelector('input[aria-label="剪辑标题"]', { visible: true });
    await page.waitForFunction(title => document.querySelector<HTMLInputElement>('input[aria-label="剪辑标题"]')?.value === title, {}, nleTitle);
    await mutation("append", () => paste('input[aria-label="剪辑标题"]', changedNleTitle), 2);
    expect(projection(store, nleObject).title).toBe(changedNleTitle);
    await mutation("undo", () => page.locator(`${workspace} button[aria-label="撤销"]`).click(), 3);
    expect(projection(store, nleObject).title).toBe(nleTitle);
    expect(projection(store, sceneObject).scenes?.[0]!.title).toBe(changedSceneTitle);
    await mutation("undo", () => page.locator(`${workspace} button[aria-label="撤销"]`).click(), 4);
    expect(projection(store, sceneObject).scenes?.[0]!.title).toBe(sceneTitle);
    await mutation("redo", () => page.locator(`${workspace} button[aria-label="重做"]`).click(), 5);
    expect(projection(store, sceneObject).scenes?.[0]!.title).toBe(changedSceneTitle);
    await mutation("redo", () => page.locator(`${workspace} button[aria-label="重做"]`).click(), 6);
    expect(projection(store, nleObject).title).toBe(changedNleTitle);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(title => document.querySelector<HTMLInputElement>('input[aria-label="剪辑标题"]')?.value === title, {}, changedNleTitle);
    await page.select(`${workspace} select`, sceneObject); await openInspector(page);
    await page.waitForFunction(title => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')?.value === title, {}, changedSceneTitle);
    const restarted = createProjectContainerStore(directory), saved = restarted.snapshot(projectId);
    expect(saved.snapshot.revision).toBe(6); expect(saved.look.undoDepth).toBe(2); expect(saved.look.redoDepth).toBe(0);
    expect((saved.snapshot.document as unknown as ProjectContainer).versions).toHaveLength(4);
    expect(projection(restarted, nleObject).title).toBe(changedNleTitle);
    expect(requests.filter(route => /^\/api\/session\/open(?:\/|$)/.test(route))).toEqual([]);
    expect(legacy.list()).toEqual([]); expect(legacyWrites).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("glint.nle.")))).toEqual([]);
    expect(errors).toEqual([]);
    if (process.env.GLINT_UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, "container-workspace-1280.png") as `${string}.png` });
    }
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
