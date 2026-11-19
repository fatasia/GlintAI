import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { migrateDocumentsToContainer, parseProjectContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let available = false; try { findSystemBrowser(); available = true; } catch { /* No implicit downloads. */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("downloads the complete saved container and reopens identical history in an isolated service", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the Web app before container export verification");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-export-browser-")), downloads = path.join(root, "downloads"), servers: Server[] = [];
  fs.mkdirSync(downloads); let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const post = (origin: string, action: string, body: unknown) => fetch(`${origin}/api/project-containers/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const start = async (name: string) => {
    const store = createProjectContainerStore(path.join(root, name));
    const server = createWebServer({ distDir: dist, projectContainerStoreFactory: () => store, requestLogDir: path.join(root, `${name}-logs`) }) as Server; servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { store, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  try {
    const scene = { schemaVersion: 1, id: "source-scene", title: "Scene", aspect: "16:9", knowledgeSources: [], originalNote: "retained source field", scenes: [{ id: "s", kind: "title", title: "Saved title", narration: { text: "Text", durationMs: 1000 } }] };
    const timeline = { schemaVersion: 1, id: "source-nle", title: "Timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "c", kind: "text", text: "Caption", startMs: 0, durationMs: 1000 }] }] };
    const original = JSON.stringify(scene), sourceFile = path.join(root, "source.json"); fs.writeFileSync(sourceFile, original);
    const { container } = await migrateDocumentsToContainer([
      { kind: "scene-document", input: scene, objectId: "scene", versionId: "s1" }, { kind: "timeline-document", input: timeline, objectId: "timeline", versionId: "t1" },
    ], { projectId: "export-browser", actor: "user", transactionId: "import" });
    const source = await start("source"), target = await start("target");
    expect((await post(source.origin, "open", { projectId: container.id, project: container, createOnly: true })).status).toBe(200);
    expect((await post(source.origin, "append", { projectId: container.id, transaction: { id: "edit", baseRevision: 0, actor: "user", scope: {}, intent: "Saved revision" }, changes: [{ objectId: "timeline", versionId: "t2", payload: { ...timeline, title: "Saved timeline revision" } }] })).status).toBe(200);
    const saved = source.store.snapshot(container.id);
    opened = await openCaptureBrowser(1440, 1000); const page = opened.page, errors: string[] = [], writes: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.includes("project-containers")) writes.push(request.url()); });
    const cdp = await page.createCDPSession(); await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await page.goto(`${source.origin}/#/c/${container.id}/scene`, { waitUntil: "networkidle0" });
    const panel = 'section[aria-label="导出完整作品 JSON"]';
    await page.waitForSelector(`${panel} button`, { visible: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="保存状态"] [role="status"]')].some(node => node.textContent?.includes("r1")));
    expect(await page.$eval(panel, node => node.textContent)).toContain("不含媒体文件");
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (process.env.GLINT_UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `container-export-${width}.png`) as `${string}.png` });
      }
    }
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/project-containers/snapshot");
    await page.locator(`${panel} button`).click(); expect((await response).status()).toBe(200);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("已导出完整作品 r1"), {}, panel);
    const file = path.join(downloads, "export-browser-r1.glint.json");
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
    const bytes = fs.readFileSync(file), exported = await parseProjectContainer(JSON.parse(bytes.toString("utf8")));
    expect(exported).toEqual(saved.snapshot.document); expect(exported.versions).toHaveLength(3); expect(exported.objects).toHaveLength(2);
    expect(exported.versions[0]!.archive?.original).toEqual(scene); expect(exported.versions[2]!.parentVersionId).toBe("t1");
    const restored = await post(target.origin, "open", { projectId: exported.id, project: exported, createOnly: true }); expect(restored.status).toBe(200);
    expect((await restored.json()).snapshot.document).toEqual(exported);
    expect((await post(target.origin, "open", { projectId: exported.id, project: exported, createOnly: true })).status).toBe(409);
    expect(source.store.snapshot(container.id)).toEqual(saved); expect(fs.readFileSync(sourceFile, "utf8")).toBe(original);
    expect(writes).toEqual([]); expect(errors).toEqual([]);
    console.info("Container export verified", JSON.stringify({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), documents: exported.objects.length, versions: exported.versions.length }));
    if (process.env.GLINT_UI_SCREENSHOT_DIR) fs.copyFileSync(file, path.join(process.env.GLINT_UI_SCREENSHOT_DIR, "export-browser-r1.glint.json"));
  } finally {
    await opened?.browser.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
