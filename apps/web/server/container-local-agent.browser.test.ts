import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { migrateDocumentToContainer, type ProjectContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let available = false; try { findSystemBrowser(); available = true; } catch { /* No implicit downloads. */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("applies a desktop-bridge NLE proposal only after confirmation through shared HTTP history", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the Web app before shared local agent verification");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-local-agent-")), directory = path.join(root, "containers");
  const store = createProjectContainerStore(directory), server = createWebServer({ distDir: dist, projectContainerStoreFactory: () => store, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const source = parseNleProject({ schemaVersion: 1, id: "original-nle", title: "Original timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "caption", kind: "text", text: "Original caption", startMs: 0, durationMs: 1000 }] }] });
  const projectId = "agent-container", objectId = "timeline-object", proposedText = "Confirmed local agent caption";
  const payload = () => { const container = store.snapshot(projectId).snapshot.document as unknown as ProjectContainer; return parseNleProject(container.versions.find(version => version.id === container.objects[0]!.currentVersionId)!.payload); };
  try {
    const { container } = await migrateDocumentToContainer(source, { kind: "timeline-document", projectId, objectId, versionId: "v1", actor: "user", transactionId: "import" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/project-containers/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, project: container, createOnly: true }) }); expect(response.status).toBe(200);
    opened = await openCaptureBrowser(1440, 1000); const page = opened.page, errors: string[] = [], writes: Array<{ url: string; body: Record<string, unknown> }> = [], oldWrites: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { const url = new URL(request.url()); if (request.method() === "POST" && (url.pathname.includes("project-containers") || url.pathname.includes("/session/"))) writes.push({ url: url.pathname, body: JSON.parse(request.postData() ?? "{}") }); });
    page.on("console", message => { if (message.text().startsWith("legacy-write:")) oldWrites.push(message.text()); });
    // Same protocol as local-agent-chat.test.ts. No CLI process, login, model or vendor call.
    await page.evaluateOnNewDocument((text: string) => {
      let state = "disconnected", sequence = 0;
      const events: Array<Record<string, unknown>> = [], calls: Array<Record<string, unknown>> = [];
      const add = (event: Record<string, unknown>) => events.push({ ...event, sequence: ++sequence });
      const modelOptions = [{ id: "model", name: "Model", category: "model", currentValue: "fixture", options: [{ value: "fixture", name: "Protocol fixture" }] }];
      Object.assign(window, { __agentBridgeCalls: calls, glintDesktop: { request: async (input: Record<string, unknown>) => {
        calls.push(structuredClone(input));
        if (input.action === "list") return { agents: [{ id: "codex", name: "Codex protocol fixture", installed: true, enabled: true, status: "installed" }], conversations: [] };
        if (input.action === "connect") { state = "idle"; add({ type: "connected", modelOptions }); return { conversationId: "fixture-conversation", state, modelOptions }; }
        if (input.action === "events") return { events: events.filter(event => Number(event.sequence) > Number(input.after)), lastSequence: sequence, state };
        if (input.action === "history") return { events, nextBefore: null, hasMore: false, incomplete: false, state };
        if (input.action === "prompt") {
          const snapshot = structuredClone(input.snapshot) as { tracks: Array<{ clips: Array<{ text?: string }> }> };
          snapshot.tracks[0]!.clips[0]!.text = text;
          add({ type: "turn-started", turnId: "turn-1", text: String(input.text) });
          add({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Please review the caption change." } } });
          add({ type: "proposal", turnId: "turn-1", project: snapshot }); add({ type: "turn-ended", turnId: "turn-1" }); state = "idle";
          return { turnId: "turn-1", state: "idle" };
        }
        if (input.action === "disconnect") { state = "disconnected"; return { state, treeStopped: true }; }
        throw new Error(`Unexpected desktop fixture action: ${String(input.action)}`);
      } } });
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string) { if (this === localStorage && key.startsWith("glint.nle.")) console.debug(`legacy-write:${key}`); return original.call(this, key, value); };
    }, proposedText);
    await page.goto(`${origin}/#/c/${projectId}/${objectId}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="剪辑标题"]')?.value === "Original timeline");
    const button = (label: string) => page.locator(`::-p-text(${label})`);
    await button("创作助手").click();
    const chat = 'section[aria-label="本地智能体聊天"]';
    await page.waitForSelector(`${chat} select[aria-label="聊天智能体"]`);
    expect(await page.$eval(`${chat} select[aria-label="聊天智能体"]`, node => node.textContent)).toContain("Codex protocol fixture");
    await button("开始对话").click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("已连接"), {}, chat);
    await page.locator(`${chat} textarea[aria-label="发给本地智能体"]`).fill("修改当前字幕，保留轨道和时长");
    await button("发送 ↑").click(); await button("查看修改差异").click();
    const diff = '[aria-label="智能体修改提案"]';
    expect(await page.$eval(diff, node => node.textContent)).toContain("Original caption"); expect(await page.$eval(diff, node => node.textContent)).toContain(proposedText);
    if (process.env.GLINT_UI_SCREENSHOT_DIR) { fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, "container-local-agent-review.png") as `${string}.png` }); }
    expect(writes).toEqual([]); expect(store.snapshot(projectId).snapshot.revision).toBe(0); expect(payload()).toEqual(source);
    const append = page.waitForResponse(value => new URL(value.url()).pathname === "/api/project-containers/append");
    await button("确认应用修改").click(); const receipt = await append; expect(receipt.status()).toBe(200); expect((await receipt.json()).receipt.stage).toBe("verified");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes("共享时间线 · r1")));
    expect(writes.filter(write => write.url.endsWith("/append"))).toHaveLength(1);
    expect(payload().id).toBe(source.id); expect(payload().tracks[0]!.clips[0]).toMatchObject({ text: proposedText, startMs: 0, durationMs: 1000 });
    const bridge = await page.evaluate(() => (window as unknown as { __agentBridgeCalls: Array<Record<string, unknown>> }).__agentBridgeCalls);
    expect(bridge.filter(call => call.action === "list").length).toBeGreaterThan(0);
    expect(bridge.filter(call => call.action === "connect")).toHaveLength(1); expect(bridge.find(call => call.action === "connect")).toMatchObject({ projectId: source.id, kind: "nle" });
    expect(bridge.filter(call => call.action === "prompt")).toHaveLength(1); expect(bridge.find(call => call.action === "prompt")?.snapshot).toEqual(source);
    expect(writes[0]!.body).toMatchObject({ projectId, transaction: { baseRevision: 0 }, changes: [{ objectId, payload: { id: source.id } }] });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes("共享时间线 · r1")));
    expect(payload().tracks[0]!.clips[0]).toMatchObject({ text: proposedText });
    const undo = page.waitForResponse(value => new URL(value.url()).pathname === "/api/project-containers/undo");
    await page.locator('[aria-label="统一作品"] button[aria-label="撤销"]').click(); expect((await undo).status()).toBe(200);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes("共享时间线 · r2")));
    expect(payload()).toEqual(source); expect((store.snapshot(projectId).snapshot.document as unknown as ProjectContainer).versions).toHaveLength(2);
    expect(createProjectContainerStore(directory).snapshot(projectId).snapshot.document).toEqual(store.snapshot(projectId).snapshot.document);
    expect(writes.filter(write => write.url.endsWith("/append"))).toHaveLength(1); expect(writes.filter(write => write.url.includes("/session/"))).toEqual([]); expect(oldWrites).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("glint.nle.")))).toEqual([]); expect(errors).toEqual([]);
    if (process.env.GLINT_UI_SCREENSHOT_DIR) { fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, "container-local-agent-restored.png") as `${string}.png` }); }
    console.info("Desktop bridge protocol fixture verified; real CLI authentication not exercised.");
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 90_000);
