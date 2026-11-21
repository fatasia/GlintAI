import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateDocumentsToContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";

// K-03 route integration: real HTTP against a throwaway store proves the
// preview is read-only (revision unchanged, no manifest files created).
let root: string, server: Server | undefined, base: string;
const sceneProject = { schemaVersion: 1, id: "proj", title: "作品", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "s1", kind: "title", title: "开场", narration: { text: "讲解", durationMs: 1000 } },
  { id: "s2", kind: "title", title: "收尾", narration: { text: "讲解", durationMs: 1000 } },
] };
const nleProject = { schemaVersion: 1, id: "nle", title: "剪辑", fps: 30, width: 1920, height: 1080, tracks: [{ id: "track", kind: "text", name: "字幕", clips: [] }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-preview-http-")); });
async function stop() { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } }
afterEach(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
async function start() {
  server = createWebServer({ requestLogDir: path.join(root, "logs"), projectContainerStoreFactory: () => createProjectContainerStore(path.join(root, "containers")) });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
async function openContainer(projectId = "work") {
  const { container } = await migrateDocumentsToContainer([
    { kind: "scene-document", input: sceneProject, objectId: "doc-scene", versionId: "v1" },
    { kind: "timeline-document", input: nleProject, objectId: "doc-timeline", versionId: "tv1" },
  ], { projectId, actor: "user", transactionId: "import" });
  const response = await fetch(`${base}/api/project-containers/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, project: container, createOnly: true }) });
  expect(response.status).toBe(200);
}
const preview = async (body: unknown, method = "POST") => {
  const response = await fetch(`${base}/api/project/plan-preview`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const storeFiles = () => fs.readdirSync(path.join(root, "containers"), { recursive: true }).map(file => String(file)).sort();

it("predicts the full rebuild without intent and never mutates project state", async () => {
  await start(); await openContainer();
  const before = storeFiles();
  const first = await preview({ projectId: "work" });
  expect(first.status).toBe(200);
  expect(first.body.version).toBe(1);
  expect(first.body.revision).toBe(0);
  expect(first.body.scope).toBe("all");
  expect(first.body.impact.predicted).toEqual(["scene:s1", "scene:s2", "audio:mix", "container"]);
  expect(first.body.impact.estimatedMs).toBeGreaterThan(0);
  expect(first.body.impact.costCny).toBe(0);
  expect(first.body.timelineExports).toEqual([{ objectId: "doc-timeline", clips: 0, durationMs: 100 }]);
  const again = await preview({ projectId: "work" });
  expect(again.body).toEqual(first.body);
  const snapshot = await (await fetch(`${base}/api/project-containers/snapshot?projectId=work`)).json();
  expect(snapshot.snapshot.revision).toBe(0);
  expect(storeFiles()).toEqual(before);
  expect(storeFiles().some(file => String(file).includes("manifest"))).toBe(false);
});

it("returns the intent closure: forced scene propagates to mix and container", async () => {
  await start(); await openContainer();
  const reply = await preview({ projectId: "work", intent: { sceneIds: ["s2"] } });
  expect(reply.status).toBe(200);
  expect(reply.body.scope).toBe("intent");
  expect(reply.body.impact.predicted).toEqual(["scene:s2", "audio:mix", "container"]);
  expect(reply.body.impact.reusedCount).toBe(1);
  expect(reply.body.impact.affectedObjects).toEqual(["doc-scene"]);
});

it("maps document intents and reports timeline intents as unmapped", async () => {
  await start(); await openContainer();
  const reply = await preview({ projectId: "work", intent: { objectIds: ["doc-timeline"] } });
  expect(reply.status).toBe(200);
  expect(reply.body.impact.predicted).toEqual([]);
  expect(reply.body.unmappedIntents).toEqual(["doc-timeline"]);
  expect(reply.body.scope).toBe("intent");
});

it("serves an empty prediction for containers without scene documents", async () => {
  await start();
  const { container } = await migrateDocumentsToContainer([
    { kind: "timeline-document", input: nleProject, objectId: "doc-timeline", versionId: "tv1" },
  ], { projectId: "empty", actor: "user", transactionId: "import" });
  const open = await fetch(`${base}/api/project-containers/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "empty", project: container, createOnly: true }) });
  expect(open.status).toBe(200);
  const reply = await preview({ projectId: "empty" });
  expect(reply.status).toBe(200);
  expect(reply.body.impact).toMatchObject({ totalNodes: 0, predicted: [], estimatedMs: 0, costCny: 0, costType: "local-free" });
  expect(reply.body.notes.some((note: string) => note.includes("没有可预测的分镜节点"))).toBe(true);
});

it("refuses malformed requests without touching storage", async () => {
  await start(); await openContainer();
  const before = storeFiles();
  expect((await preview({ projectId: "work", intent: { extra: 1 } })).status).toBe(400);
  expect((await preview({ projectId: "work", intent: { sceneIds: ["ghost"] } })).status).toBe(400);
  expect((await preview({ projectId: "work", intent: { objectIds: ["ghost"] } })).status).toBe(400);
  expect((await preview({ projectId: "work", intent: {} })).status).toBe(400);
  expect((await preview({ projectId: "missing" })).status).toBe(404);
  expect((await preview({ projectId: "../outside" })).status).toBe(400);
  expect((await preview({ projectId: "work" }, "GET")).status).toBe(405);
  expect(storeFiles()).toEqual(before);
  const bad = await preview({ projectId: "work", intent: { sceneIds: ["ghost"] } });
  expect(JSON.stringify(bad.body.error)).toContain("ghost");
  expect(JSON.stringify(bad.body)).not.toContain(root);
});
