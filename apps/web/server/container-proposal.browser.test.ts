import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject, type NleProject } from "@glintai/scenescript";
import { migrateDocumentsToContainer } from "@glintai/scenescript/project-container";
import { FileSessionStore } from "@glintai/session/node";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no downloads */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("confirms model proposals through shared container CAS and preserves a conflicting draft", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-proposal-"));
  const projectId = "shared-proposal", objectId = "timeline-object";
  const timeline = { schemaVersion: 1, id: "original-timeline", title: "共同作品", fps: 30, width: 1280, height: 720,
    tracks: [{ id: "text", kind: "text", name: "字幕", clips: [{ id: "caption", kind: "text", text: "原字幕", startMs: 0, durationMs: 2000 }] }] };
  const project = (await migrateDocumentsToContainer([{ kind: "timeline-document", input: timeline, objectId, versionId: "v1" }], { projectId, actor: "user", transactionId: "import" })).container;
  const store = createProjectContainerStore(path.join(root, "containers"));
  const legacy = new FileSessionStore(path.join(root, "legacy"), value => { parseProject(value); });
  const modelCalls: unknown[] = [];
  const llm = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); modelCalls.push(JSON.parse(body.messages.at(-1).content));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ id: "caption", text: "模型新字幕", color: "#ffcc00" }] }) } }] }));
  });
  const keys = ["GLINT_LLM_BASE_URL", "GLINT_LLM_API_KEY", "GLINT_LLM_MODEL", "GLINT_LLM_PROTOCOL", "GLINT_LLM_REASONING_EFFORT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), sessionStore: legacy, projectContainerStoreFactory: () => store, requestLogDir: path.join(root, "logs") });
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const current = () => { const container = store.snapshot(projectId).snapshot.document; const object = container.objects.find(item => item.id === objectId)!; return container.versions.find(v => v.id === object.currentVersionId)!.payload as NleProject; };
  try {
    await new Promise<void>(resolve => llm.listen(0, "127.0.0.1", resolve));
    process.env.GLINT_LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
    process.env.GLINT_LLM_API_KEY = "local-fixture"; process.env.GLINT_LLM_MODEL = "local-fixture"; process.env.GLINT_LLM_PROTOCOL = "openai"; delete process.env.GLINT_LLM_REASONING_EFFORT;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (action: string, body: unknown) => fetch(`${origin}/api/project-containers/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("open", { projectId, project, createOnly: true })).status).toBe(200);
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    const requests: string[] = [], appendBodies: Array<{ projectId: string; transaction: { baseRevision: number }; changes: Array<{ objectId: string; payload: NleProject }> }> = [], errors: string[] = [], legacyWrites: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (message.text().startsWith("legacy-nle-write:")) legacyWrites.push(message.text()); });
    await page.evaluateOnNewDocument(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (this === localStorage && key.startsWith("glint.nle.")) console.debug(`legacy-nle-write:${key}`); return set.call(this, key, value); }; });
    page.on("request", request => { const route = new URL(request.url()).pathname; requests.push(route); if (route === "/api/project-containers/append") appendBodies.push(JSON.parse(request.postData()!)); });
    await page.goto(`${origin}/#/c/${projectId}/${objectId}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector('[aria-label="共享时间线 · r0"]')?.textContent?.includes("共享时间线 · r0"));
    const openProposal = async () => {
      await page.locator('.nle-menu-wrap > summary::-p-text(工程)').click();
      await page.locator('summary::-p-text(AI 文字提案)').click();
      await page.locator('input[aria-label="时间线文字修改要求"]').fill("精简字幕");
    };
    const generate = async () => {
      await page.locator('details:has(input[aria-label="时间线文字修改要求"]) input[type="checkbox"]').click();
      const before = store.snapshot(projectId).snapshot;
      await page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/snapshot", { timeout: 10000 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(store.snapshot(projectId).snapshot.digest).toBe(before.digest);
      expect(await page.$eval('details:has(input[aria-label="时间线文字修改要求"]) input[type="checkbox"]', el => (el as HTMLInputElement).checked)).toBe(true);
      await page.locator('button::-p-text(生成文字提案)').click();
      await page.waitForSelector('[aria-label="修改差异预览"]', { visible: true, timeout: 10000 });
      expect(await page.$eval('[aria-label="修改差异预览"]', el => el.textContent)).toContain("模型新字幕");
    };
    await openProposal();
    expect(await page.$eval('button::-p-text(生成文字提案)', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await generate(); expect(appendBodies).toHaveLength(0);
    await page.locator('[aria-label="修改差异预览"] button::-p-text(取消)').click();
    expect(store.snapshot(projectId).snapshot.revision).toBe(0); expect(appendBodies).toHaveLength(0);
    await generate();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/append");
    await page.locator('[aria-label="修改差异预览"] button::-p-text(应用修改)').click();
    const receipt = await saved; expect(receipt.status()).toBe(200); expect((await receipt.json()).receipt.stage).toBe("verified");
    expect(appendBodies).toHaveLength(1); expect(appendBodies[0]).toMatchObject({ projectId, transaction: { baseRevision: 0 }, changes: [{ objectId, payload: { id: "original-timeline" } }] });
    expect(current().tracks[0]!.clips[0]).toMatchObject({ text: "模型新字幕", color: "#ffcc00" });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector('[aria-label="共享时间线 · r1"]')?.textContent?.includes("共享时间线 · r1"));
    const undone = page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/undo");
    await page.locator('button[aria-label="撤销"]').click(); expect((await undone).status()).toBe(200);
    expect(current().tracks[0]!.clips[0]).toMatchObject({ text: "原字幕" }); expect(current().tracks[0]!.clips[0]).not.toHaveProperty("color");
    await page.waitForFunction(() => document.querySelector('[aria-label="共享时间线 · r2"]')?.textContent?.includes("共享时间线 · r2"));
    await openProposal(); await generate();
    await page.setRequestInterception(true);
    page.on("request", request => { if (new URL(request.url()).pathname !== "/api/project-containers/append") void request.continue(); });
    const pending = page.waitForRequest(request => new URL(request.url()).pathname === "/api/project-containers/append");
    const conflict = page.waitForResponse(response => new URL(response.url()).pathname === "/api/project-containers/append");
    await page.locator('[aria-label="修改差异预览"] button::-p-text(应用修改)').click(); const held = await pending;
    const external = await post("append", { projectId, transaction: { id: "external", baseRevision: 2, actor: "user", scope: {}, intent: "Concurrent title edit" }, changes: [{ objectId, versionId: "external-v1", payload: { ...current(), title: "另一入口改名" } }] });
    expect(external.status).toBe(200); await held.continue(); expect((await conflict).status()).toBe(409);
    await page.waitForSelector('[role="alert"] button::-p-text(备份草稿并接续共享版本)', { visible: true, timeout: 10000 });
    expect(current().title).toBe("另一入口改名"); expect(current().tracks[0]!.clips[0]).toMatchObject({ text: "原字幕" });
    await page.locator('button::-p-text(备份草稿并接续共享版本)').click();
    const drafts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("glint.container-draft:")).map(key => JSON.parse(localStorage.getItem(key)!)));
    expect(drafts).toHaveLength(1); expect(drafts[0].tracks[0].clips[0]).toMatchObject({ text: "模型新字幕", color: "#ffcc00" });
    expect(appendBodies).toHaveLength(2); expect(modelCalls).toHaveLength(3); expect(store.snapshot(projectId).snapshot.revision).toBe(3);
    expect(requests.filter(route => route.startsWith("/api/session/"))).toEqual([]); expect(legacy.list()).toEqual([]); expect(legacyWrites).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("glint.nle.")))).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); llm.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => llm.close(() => resolve()))]);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected cleanup path"); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
