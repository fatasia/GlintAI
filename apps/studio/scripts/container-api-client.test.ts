import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "../../web/server/project-container-session";
const { createWebServer } = await import(new URL("../../web/server/index.mjs", import.meta.url).href) as { createWebServer(options: Record<string, unknown>): Server };
import { listContainers, containerRequest, CONTAINER_REQUEST_LIMIT, CONTAINER_RESPONSE_LIMIT } from "./container-api-client";

let root: string, server: Server | undefined, endpoint: string, calls: number;
const token = "fixture-only-token-longer-than-24-characters";
const scene = { schemaVersion: 1, id: "original-scene", title: "Original", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "shot", kind: "title", title: "原稿", narration: { text: "原稿", durationMs: 1000 } }] };
const timeline = { schemaVersion: 1, id: "original-nle", title: "剪辑", fps: 30, width: 1920, height: 1080, tracks: [{ id: "track", kind: "video", name: "视频", clips: [] }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "container-client-")); calls = 0; });
async function stop() { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await stop(); fs.rmSync(root, { recursive: true, force: true }); });
async function listen(value: Server) { server = value; server.on("request", () => calls++); await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/glint`; }
async function start() { await listen(createWebServer({ basePath: "/glint/", publicHost: "test.example", accessToken: token, authRequired: true, requestLogDir: path.join(root, "logs"), projectContainerStoreFactory: () => createProjectContainerStore(path.join(root, "store")) })); }
const request = (action: Parameters<typeof containerRequest>[0], body: Record<string, unknown>) => containerRequest(action, body, { endpoint, token });
async function fixture() {
  const a = (await migrateDocumentToContainer(scene, { kind: "scene-document", projectId: "work", objectId: "scene-doc", versionId: "scene-v1", transactionId: "import-scene", actor: "cli" })).container;
  const b = (await migrateDocumentToContainer(timeline, { kind: "timeline-document", projectId: "other", objectId: "nle-doc", versionId: "nle-v1", transactionId: "import-nle", actor: "cli" })).container;
  return { ...a, objects: [...a.objects, ...b.objects], versions: [...a.versions, ...b.versions] };
}
const edit = (id = "edit", baseRevision = 0) => ({ projectId: "work", transaction: { id, baseRevision, actor: "cli", scope: {}, intent: "更新两份文档" }, changes: [{ objectId: "scene-doc", versionId: "scene-v2", payload: { ...scene, title: "Changed" } }, { objectId: "nle-doc", versionId: "nle-v2", payload: { ...timeline, title: "Changed" } }] });
it("uses real HTTP shared CAS, explicit idempotency, global history and persistent restart", async () => {
  await start(); const project = await fixture();
  expect((await request("open", { projectId: "work", project, createOnly: true })).snapshot.revision).toBe(0);
  const saved = await request("append", edit()); expect(saved.receipt?.stage).toBe("verified"); expect(saved.snapshot.revision).toBe(1);
  expect(saved.snapshot.document.objects.map(o => o.currentVersionId)).toEqual(["scene-v2", "nle-v2"]);
  expect((await request("append", edit())).receipt).toEqual(saved.receipt);
  const count = calls;
  await expect(request("append", edit("stale", 0))).rejects.toMatchObject({ code: "refused", status: 409, result: { receipt: { transactionId: "stale", stage: "refused" } } });
  expect(calls).toBe(count + 1);
  const undo = await request("undo", { projectId: "work", transactionId: "undo", baseRevision: 1, actor: "cli" });
  expect(undo.snapshot.document.objects.map(o => o.currentVersionId)).toEqual(["scene-v1", "nle-v1"]);
  const redo = await request("redo", { projectId: "work", transactionId: "redo", baseRevision: 2, actor: "cli" });
  expect(redo.snapshot.revision).toBe(3); expect(redo.snapshot.document.versions).toHaveLength(4);
  await stop(); await start(); expect((await request("snapshot", { projectId: "work" })).snapshot).toEqual(redo.snapshot);
});
it("drives v2 migration and lifecycle through the same verified HTTP client", async () => {
  await start(); const project = await fixture();
  expect((await request("open", { projectId: "work", project, createOnly: true })).snapshot.revision).toBe(0);
  const copy = await request("migrate-copy", { projectId: "work-v2", sourceProjectId: "work" });
  expect(copy.snapshot.document.version).toBe(2);
  if (copy.snapshot.document.version !== 2) throw new Error("Expected a version 2 container");
  expect(copy.snapshot.document.migration).toMatchObject({ sourceProjectId: "work" });
  const saved = await request("lifecycle", { projectId: "work-v2", transaction: { id: "add-script", baseRevision: 0, actor: "cli", scope: {}, intent: "添加脚本" }, change: { action: "add", objectId: "script", versionId: "script-v1", kind: "script-document", payload: { id: "script-doc", title: "脚本", kind: "script", content: "", updatedAt: 0 } } });
  expect(saved.receipt?.stage).toBe("verified"); expect(saved.snapshot.revision).toBe(1);
  expect((await request("lifecycle", { projectId: "work-v2", transaction: { id: "add-script", baseRevision: 0, actor: "cli", scope: {}, intent: "添加脚本" }, change: { action: "add", objectId: "script", versionId: "script-v1", kind: "script-document", payload: { id: "script-doc", title: "脚本", kind: "script", content: "", updatedAt: 0 } } })).receipt).toEqual(saved.receipt);
  await expect(request("lifecycle", { projectId: "work-v2", transaction: { id: "stale", baseRevision: 0, actor: "cli", scope: {}, intent: "过期" }, change: { action: "archive", objectId: "script" } })).rejects.toMatchObject({ code: "refused", status: 409 });
  const current = await request("snapshot", { projectId: "work-v2" });
  expect(current.snapshot.document.objects.at(-1)).toMatchObject({ id: "script", kind: "script-document", archived: false });
});
it("retains originals and rejects an open conflict and missing auth without exposing token", async () => {
  await start(); const project = await fixture(); await request("open", { projectId: "work", project });
  await expect(containerRequest("snapshot", { projectId: "work" }, { endpoint })).rejects.toMatchObject({ code: "http-refused", status: 401 });
  await expect(request("open", { projectId: "work", project: { ...project, title: "different" } })).rejects.toMatchObject({ code: "refused" });
  expect((await request("snapshot", { projectId: "work" })).snapshot.document).toEqual(project);
});
it("rejects unsafe endpoints, missing CAS and oversized requests before network", async () => {
  await start();
  for (const bad of ["http://user:secret@localhost", "http://example.test", "file:///tmp/x", endpoint + "?token=x", endpoint + "#x"])
    await expect(containerRequest("snapshot", { projectId: "work" }, { endpoint: bad, token })).rejects.toMatchObject({ name: "ContainerRequestError" });
  await expect(request("append", { projectId: "work", transaction: { baseRevision: 0 } })).rejects.toMatchObject({ code: "invalid-identity" });
  await expect(request("undo", { projectId: "work", transactionId: "tx" })).rejects.toMatchObject({ code: "invalid-revision" });
  await expect(request("open", { projectId: "work", project: "x".repeat(CONTAINER_REQUEST_LIMIT) })).rejects.toMatchObject({ code: "request-too-large" });
  expect(calls).toBe(0);
});
it("does not follow redirects or retry dropped responses and respects cancellation", async () => {
  await listen(createServer((_req, res) => { res.writeHead(302, { location: "http://other.invalid/steal" }); res.end(); }));
  await expect(request("snapshot", { projectId: "work" })).rejects.toMatchObject({ code: "transport-failed" }); expect(calls).toBe(1);
  await stop(); await listen(createServer(req => req.socket.destroy()));
  await expect(request("undo", { projectId: "work", transactionId: "one", baseRevision: 0, actor: "cli" })).rejects.toMatchObject({ code: "transport-failed" }); expect(calls).toBe(2);
  const controller = new AbortController(); controller.abort();
  await expect(containerRequest("snapshot", { projectId: "work" }, { endpoint, signal: controller.signal })).rejects.toMatchObject({ code: "aborted" }); expect(calls).toBe(2);
});
it("bounds declared and chunked response bodies", async () => {
  await listen(createServer((_req, res) => { res.writeHead(200, { "content-length": CONTAINER_RESPONSE_LIMIT + 1 }); res.end("{}"); }));
  await expect(request("snapshot", { projectId: "work" })).rejects.toMatchObject({ code: "response-too-large" });
  await stop(); await listen(createServer((_req, res) => { res.writeHead(200); res.end('"' + "x".repeat(CONTAINER_RESPONSE_LIMIT) + '"'); }));
  await expect(request("snapshot", { projectId: "work" })).rejects.toMatchObject({ code: "response-too-large" });
});
it("rejects forged identities, digests and receipts from a real HTTP boundary", async () => {
  await start(); await request("open", { projectId: "work", project: await fixture() }); const saved = await request("append", edit()); await stop();
  let body: unknown;
  await listen(createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); }));
  for (const mutate of [
    (v: typeof saved) => { v.snapshot.projectId = "other"; },
    (v: typeof saved) => { v.snapshot.digest = v.look.digest = "forged"; },
    (v: typeof saved) => { v.receipt!.transactionId = "wrong"; },
    (v: typeof saved) => { v.receipt!.documentSha256 = "0".repeat(64); },
  ]) { const value = structuredClone(saved); mutate(value); body = value; await expect(request("append", edit())).rejects.toMatchObject({ name: "ContainerRequestError" }); }
});
it("times out a hanging response using the bounded signal", async () => {
  await listen(createServer((_req, res) => { res.writeHead(200); res.write("{"); }));
  const original = AbortSignal.timeout; vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(20));
  await expect(request("snapshot", { projectId: "work" })).rejects.toMatchObject({ code: "aborted" }); expect(calls).toBe(1);
});

it("lists bounded metadata through authenticated real HTTP and rejects malformed responses", async () => {
  let body: unknown = { projects: [{ projectId: "a", revision: 2, title: "作品", sceneCount: 1, timelineCount: 0, firstDocumentId: "doc" }], nextCursor: "a" };
  const seen: string[] = [];
  await listen(createServer((req, res) => { seen.push(req.url!); expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`glint:${token}`).toString("base64")}`); res.end(JSON.stringify(body)); }));
  expect(await listContainers({ endpoint, token, limit: 1 })).toEqual(body);
  body = { projects: [{ projectId: "b", revision: 0, title: "🎬".repeat(160), sceneCount: 0, timelineCount: 1 }], nextCursor: null };
  expect(await listContainers({ endpoint, token, limit: 1, cursor: "a" })).toEqual(body);
  expect(seen).toEqual(["/glint/api/project-containers/list?limit=1", "/glint/api/project-containers/list?limit=1&cursor=a"]);
  const row = { projectId: "a", revision: 0, title: "Title", sceneCount: 1, timelineCount: 0 };
  for (const invalid of [
    { projects: [row], nextCursor: "other" }, { projects: [], nextCursor: "a" }, { projects: [row, row], nextCursor: null },
    { projects: [{ ...row, title: "a".repeat(161) }], nextCursor: null }, { projects: [{ ...row, archive: "secret" }], nextCursor: null },
    { projects: [{ ...row, sceneCount: -1 }], nextCursor: null }, { projects: [row] }, { projects: [row], nextCursor: null, path: "secret" },
  ]) { body = invalid; await expect(listContainers({ endpoint, token })).rejects.toThrow(); }
  const before = calls;
  for (const limit of [0, 51, 1.2, NaN]) await expect(listContainers({ endpoint, limit })).rejects.toMatchObject({ code: "invalid-limit" });
  await expect(listContainers({ endpoint, cursor: "../bad" })).rejects.toThrow(); expect(calls).toBe(before);
});
it("retains list transport boundaries for redirects, credentials, size and abort", async () => {
  await expect(listContainers({ endpoint: "http://remote.example", token })).rejects.toMatchObject({ code: "insecure-endpoint" });
  await listen(createServer((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/foreign" }); res.end(); }));
  await expect(listContainers({ endpoint, token })).rejects.toMatchObject({ code: "transport-failed" }); expect(calls).toBe(1);
  await stop(); await listen(createServer((_req, res) => { res.writeHead(200, { "content-length": CONTAINER_RESPONSE_LIMIT + 1 }); res.end("{}"); }));
  await expect(listContainers({ endpoint })).rejects.toMatchObject({ code: "response-too-large" });
  await stop(); await listen(createServer((_req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: token })); }));
  await expect(listContainers({ endpoint })).rejects.toMatchObject({ code: "http-refused", status: 401, message: "Container request http-refused" });
  await stop(); await listen(createServer((_req, res) => { res.end("{"); }));
  await expect(listContainers({ endpoint })).rejects.toMatchObject({ code: "invalid-response-json" });
  const before = calls, signal = AbortSignal.abort();
  await expect(listContainers({ endpoint, signal })).rejects.toMatchObject({ code: "aborted" }); expect(calls).toBe(before);
});
