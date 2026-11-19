import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileSessionStore } from "@glintai/session/node";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";

let root: string, server: Server | undefined, base: string, factories: number;
const document = { schemaVersion: 1, id: "original", title: "原作品", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "scene", kind: "title", title: "原内容", narration: { text: "保留", durationMs: 1000 } }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "container-http-")); factories = 0; });
async function stop() { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } }
afterEach(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
async function start(options: Record<string, unknown> = {}) {
  server = createWebServer({ requestLogDir: path.join(root, "logs"), projectContainerStoreFactory: () => { factories++; return createProjectContainerStore(path.join(root, "containers")); }, ...options });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
async function container() { return (await migrateDocumentToContainer(document, { kind: "scene-document", projectId: "work", objectId: "doc", versionId: "v1", actor: "user", transactionId: "import" })).container; }
async function post(action: string, body: unknown, prefix = "", headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${prefix}/api/project-containers/${action}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const change = (id: string, baseRevision: number, title: string) => ({ projectId: "work", transaction: { id, baseRevision, actor: "user", scope: {}, intent: "修改标题" }, changes: [{ objectId: "doc", versionId: `version-${id}`, payload: { ...document, title } }] });

it("uses one persistent CAS history for edit, replay, conflict, undo, redo and restart", async () => {
  await start();
  expect((await post("open", { projectId: "work", project: await container(), createOnly: true })).status).toBe(200);
  const submitted = change("edit", 0, "修改后"), first = await post("append", submitted);
  expect(first.status).toBe(200); expect(first.body.snapshot.revision).toBe(1);
  expect((await post("append", submitted)).body.snapshot.revision).toBe(1);
  expect((await post("append", change("stale", 0, "旧稿"))).status).toBe(409);
  const undo = await post("undo", { projectId: "work", transactionId: "undo", baseRevision: 1, actor: "user" });
  expect(undo.status).toBe(200); expect(undo.body.snapshot.document.versions).toHaveLength(2);
  expect(undo.body.snapshot.document.objects[0].currentVersionId).toBe("v1");
  const redo = await post("redo", { projectId: "work", transactionId: "redo", baseRevision: 2, actor: "user" });
  expect(redo.status).toBe(200); expect(redo.body.snapshot.document.objects[0].currentVersionId).toBe("version-edit");
  await stop(); await start();
  const snapshot = await (await fetch(`${base}/api/project-containers/snapshot?projectId=work`)).json();
  expect(snapshot.snapshot.revision).toBe(3); expect(snapshot.snapshot.document).toEqual(redo.body.snapshot.document);
});

it("rejects unknown fields and identities before initializing storage", async () => {
  await start(); await fetch(`${base}/api/health`); expect(factories).toBe(0);
  expect((await post("open", { projectId: "work", project: await container(), directory: root })).status).toBe(400);
  expect((await post("open", { projectId: "../outside", project: await container() })).status).toBe(400);
  expect(factories).toBe(0); expect(fs.existsSync(path.join(root, "containers"))).toBe(false);
});

it("inherits host authentication and origin protections", async () => {
  const token = "test-only-token-longer-than-24-characters";
  await start({ publicHost: "glint.example.test", accessToken: token, authRequired: true });
  const body = { projectId: "work", project: await container() };
  expect((await post("open", body)).status).toBe(401);
  const authorization = `Basic ${Buffer.from(`glint:${token}`).toString("base64")}`;
  expect((await post("open", body, "", { authorization, origin: "https://foreign.example.test" })).status).toBe(403);
  expect(factories).toBe(0);
  expect((await post("open", body, "", { authorization })).status).toBe(200);
});

it("supports the existing base path and gives bounded errors without local paths", async () => {
  await start({ basePath: "/glint/" });
  expect((await post("open", { projectId: "work", project: await container() })).status).toBe(404);
  expect((await post("open", { projectId: "work", project: await container() }, "/glint")).status).toBe(200);
  const invalid = await post("append", { ...change("bad", 0, "坏输入"), changes: [{ objectId: "missing", versionId: "v2", payload: {} }] }, "/glint");
  expect(invalid.status).toBe(400); expect(JSON.stringify(invalid.body)).not.toContain(root);
  const response = await fetch(`${base}/glint/api/project-containers/snapshot?projectId=absent`);
  expect(response.status).toBe(404);
});

it("lists only readable containers with stable ASCII pages and bounded current-document metadata", async () => {
  await start(); const original = await container();
  const timeline = (await migrateDocumentToContainer({ schemaVersion: 1, id: "source-nle", title: "🎬".repeat(20) + "题".repeat(150), fps: 30, width: 1920, height: 1080, tracks: [{ id: "track", kind: "video", name: "画面", clips: [] }] }, { kind: "timeline-document", projectId: "source", objectId: "timeline-doc", versionId: "timeline-v1", actor: "user", transactionId: "import-timeline" })).container;
  for (const projectId of ["z", "a", "A2", "A10", "B"]) {
    const project = { ...original, id: projectId, objects: [...timeline.objects, ...original.objects], versions: [...timeline.versions, ...original.versions] };
    expect((await post("open", { projectId, project })).status).toBe(200);
  }
  const directory = path.join(root, "containers");
  new FileSessionStore(directory).open("not-container", { ...document, id: "not-container" });
  fs.writeFileSync(path.join(directory, createHash("sha256").update("broken").digest("hex") + ".json"), "broken");
  const before = Object.fromEntries(fs.readdirSync(directory).map(file => [file, fs.readFileSync(path.join(directory, file), "utf8")]));
  const page = async (query: string) => { const response = await fetch(`${base}/api/project-containers/list${query}`); expect(response.status).toBe(200); return response.json(); };
  const first = await page("?limit=2"); expect(first.projects.map((row: { projectId: string }) => row.projectId)).toEqual(["A10", "A2"]); expect(first.nextCursor).toBe("A2");
  expect(first.projects[0]).toEqual({ projectId: "A10", revision: 0, title: "🎬".repeat(20) + "题".repeat(140), sceneCount: 1, timelineCount: 1, firstDocumentId: "timeline-doc" });
  const second = await page("?limit=2&cursor=A2"); expect(second.projects.map((row: { projectId: string }) => row.projectId)).toEqual(["B", "a"]); expect(second.nextCursor).toBe("a");
  const last = await page("?limit=2&cursor=a"); expect(last.projects.map((row: { projectId: string }) => row.projectId)).toEqual(["z"]); expect(last.nextCursor).toBeNull();
  expect(await page("?cursor=z")).toEqual({ projects: [], nextCursor: null });
  expect(JSON.stringify(first)).not.toMatch(/archive|payload|source-nle|original|containers/);
  expect(Object.fromEntries(fs.readdirSync(directory).map(file => [file, fs.readFileSync(path.join(directory, file), "utf8")]))).toEqual(before);
  await stop(); await start(); expect(await page("?limit=2")).toEqual(first);
});
it("uses current version titles, fallback IDs and default/max page limits without exposing records", async () => {
  await start(); const original = await container();
  expect((await post("open", { projectId: "work", project: original })).status).toBe(200);
  expect((await post("append", change("title", 0, "当前标题"))).status).toBe(200);
  for (let i = 0; i < 51; i++) { const projectId = `empty${String(i).padStart(2, "0")}`; expect((await post("open", { projectId, project: { format: "glint-project", version: 1, id: projectId, objects: [], versions: [] } })).status).toBe(200); }
  const defaultPage = await (await fetch(`${base}/api/project-containers/list`)).json(); expect(defaultPage.projects).toHaveLength(20); expect(defaultPage.nextCursor).toBe("empty19");
  expect(defaultPage.projects[0]).toEqual({ projectId: "empty00", revision: 0, title: "empty00", sceneCount: 0, timelineCount: 0 });
  const maxPage = await (await fetch(`${base}/api/project-containers/list?limit=50`)).json(); expect(maxPage.projects).toHaveLength(50); expect(maxPage.nextCursor).toBe("empty49");
  const tail = await (await fetch(`${base}/api/project-containers/list?cursor=empty50`)).json(); expect(tail).toEqual({ projects: [{ projectId: "work", revision: 1, title: "当前标题", sceneCount: 1, timelineCount: 0, firstDocumentId: "doc" }], nextCursor: null });
});
it("rejects unknown, duplicate and malformed list parameters before opening storage", async () => {
 await start();
 for (const query of ["?limit=0", "?limit=51", "?limit=-1", "?limit=1.5", "?limit=01", "?limit=", "?limit=2&limit=3", "?cursor=", "?cursor=../x", "?cursor=a&cursor=b", "?directory=x", "?payload=true"]) expect((await fetch(`${base}/api/project-containers/list${query}`)).status).toBe(400);
 expect((await post("list", {})).status).toBe(405); expect(factories).toBe(0);
 expect((await fetch(`${base}/api/project-containers/list?cursor=absent`)).status).toBe(400);
 expect(await (await fetch(`${base}/api/project-containers/list`)).json()).toEqual({ projects: [], nextCursor: null });
});
it("applies existing authentication and base-path protection to listing", async () => {
 const token = "fixture-token-more-than-24-characters";
 await start({ basePath: "/glint/", publicHost: "list.test", accessToken: token, authRequired: true });
 expect((await fetch(`${base}/glint/api/project-containers/list`)).status).toBe(401); expect(factories).toBe(0);
 const headers = { authorization: `Basic ${Buffer.from(`glint:${token}`).toString("base64")}` };
 expect((await fetch(`${base}/api/project-containers/list`, { headers })).status).toBe(404);
 const response = await fetch(`${base}/glint/api/project-containers/list`, { headers }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ projects: [], nextCursor: null });
 expect((await fetch(`${base}/glint/api/project-containers/list`, { method: "POST", headers: { ...headers, origin: "https://foreign.test" }, body: "{}" })).status).toBe(403);
});
