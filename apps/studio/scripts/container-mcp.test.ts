import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { migrateDocumentToContainer, parseProjectContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "../../web/server/project-container-session";
import { containerTools } from "./container-mcp";
import { createMcpHandler } from "./mcp";

let server: Server | undefined, root: string | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (root) { fs.rmSync(root, { recursive: true, force: true }); root = undefined; }
});

const scene = { schemaVersion: 1, id: "scene-original", title: "Scene", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "opening", kind: "title", title: "Opening", narration: { text: "Local fixture", durationMs: 2000 } }] };
const timeline = { schemaVersion: 1, id: "timeline-original", title: "Timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Caption track", clips: [{ id: "caption", kind: "text", text: "Caption", startMs: 0, durationMs: 2000 }] }] };
async function fixture() {
  const a = await migrateDocumentToContainer(scene, { kind: "scene-document", projectId: "mcp-work", objectId: "scene", versionId: "scene-v1", actor: "skill", transactionId: "import" });
  const b = await migrateDocumentToContainer(timeline, { kind: "timeline-document", projectId: "mcp-work", objectId: "timeline", versionId: "timeline-v1", actor: "skill", transactionId: "import" });
  return parseProjectContainer({ ...a.container, objects: [...a.container.objects, ...b.container.objects], versions: [...a.container.versions, ...b.container.versions] });
}

async function start() {
  const serverModule = "../../web/server/index.mjs";
  const { createWebServer } = await import(serverModule) as { createWebServer(options: Record<string, unknown>): Server };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-mcp-"));
  const directory = path.join(root, "containers"), store = createProjectContainerStore(directory);
  const token = "test-only-container-access-token";
  server = createWebServer({ distDir: root, basePath: "/studio/", publicHost: "glint.example.test", authRequired: true, accessToken: token, requestLogDir: path.join(root, "logs"), projectContainerStoreFactory: () => store }) as Server;
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/studio/`;
  const tools = containerTools({ GLINT_CONTAINER_ENDPOINT: endpoint, GLINT_ACCESS_TOKEN: token });
  const handler = createMcpHandler(tools);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `glint_container_${name}`, arguments: args } });
    return response!.result as { isError: boolean; content: Array<{ text: string }> };
  };
  return { store, directory, tools, call, token };
}

it("uses authenticated real HTTP for atomic two-document edits, replay, shared history and persistent restart", async () => {
  const { call, store, directory } = await start();
  expect((await call("open", { projectId: "mcp-work", project: await fixture() })).isError).toBe(false);
  const args = { projectId: "mcp-work", transactionId: "agent-edit", baseRevision: 0, changes: [
    { objectId: "scene", versionId: "scene-v2", payload: { ...scene, title: "Shared scene" } },
    { objectId: "timeline", versionId: "timeline-v2", payload: { ...timeline, title: "Shared timeline" } },
  ] };
  const saved = await call("append", args);
  expect(saved.isError).toBe(false);
  expect(JSON.parse(saved.content[0]!.text)).toMatchObject({ snapshot: { projectId: "mcp-work", revision: 1 }, receipt: { transactionId: "agent-edit", stage: "verified" } });
  expect((await call("append", args)).isError).toBe(false);
  expect(store.snapshot("mcp-work").snapshot.revision).toBe(1);
  expect((await call("append", { ...args, transactionId: "stale-edit" })).isError).toBe(true);
  const undo = await call("undo", { projectId: "mcp-work", transactionId: "agent-undo", baseRevision: 1 });
  expect(undo.isError).toBe(false);
  expect(store.snapshot("mcp-work").snapshot.document.objects).toEqual(expect.arrayContaining([expect.objectContaining({ currentVersionId: "scene-v1" }), expect.objectContaining({ currentVersionId: "timeline-v1" })]));
  expect((await call("redo", { projectId: "mcp-work", transactionId: "agent-redo", baseRevision: 2 })).isError).toBe(false);
  expect((await call("snapshot", { projectId: "mcp-work" })).isError).toBe(false);
  const restarted = createProjectContainerStore(directory).snapshot("mcp-work");
  expect(restarted.snapshot.revision).toBe(3);
  expect(restarted.snapshot.document.versions).toHaveLength(4);
  expect(restarted.snapshot.document.objects).toEqual(expect.arrayContaining([expect.objectContaining({ currentVersionId: "scene-v2" }), expect.objectContaining({ currentVersionId: "timeline-v2" })]));
});

it("refuses overwrites, argument-supplied endpoints/credentials and forged actors", async () => {
  const { call, store, token } = await start();
  const open = { projectId: "mcp-work", project: await fixture() };
  expect((await call("open", open)).isError).toBe(false);
  expect((await call("open", open)).isError).toBe(true);
  for (const extra of [{ endpoint: "https://foreign.example.test" }, { token: "not-a-process-credential" }, { actor: "user" }]) {
    const denied = await call("snapshot", { projectId: "mcp-work", ...extra });
    expect(denied.isError).toBe(true); expect(denied.content[0]!.text).toContain("Unknown container argument");
    expect(denied.content[0]!.text).not.toContain(token);
  }
  expect(store.snapshot("mcp-work").snapshot.revision).toBe(0);
});

it("advertises no credential or endpoint argument and fails clearly without a configured service", async () => {
  const tools = containerTools({});
  expect(tools).toHaveLength(8);
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties: object; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("endpoint"); expect(schema.properties).not.toHaveProperty("token");
  }
  expect(() => tools[0]!.call({ projectId: "work" })).toThrow("GLINT_CONTAINER_ENDPOINT");
});


it("discovers multiple works through MCP pagination without payloads or model-selected credentials", async () => {
  const { call, token } = await start(), project = await fixture();
  for (const id of ["a-work", "b-work"]) expect((await call("open", { projectId: id, project: { ...project, id } })).isError).toBe(false);
  const first = await call("list", { limit: 1 }); expect(first.isError).toBe(false);
  expect(JSON.parse(first.content[0]!.text)).toEqual({ projects: [{ projectId: "a-work", revision: 0, title: "Scene", sceneCount: 1, timelineCount: 1, firstDocumentId: "scene" }], nextCursor: "a-work" });
  const second = await call("list", { limit: 1, cursor: "a-work" }); expect(second.isError).toBe(false);
  expect(JSON.parse(second.content[0]!.text)).toMatchObject({ projects: [{ projectId: "b-work" }], nextCursor: null });
  expect(second.content[0]!.text).not.toContain(token); expect(second.content[0]!.text).not.toContain("payload");
  for (const args of [{ endpoint: "https://foreign.test" }, { token: "SECRET" }, { limit: "1" }, { limit: 51 }, { cursor: null }, { projectId: "a-work" }]) expect((await call("list", args)).isError).toBe(true);
});

const script = { id: "script-doc", title: "Script", kind: "script", content: "Original", updatedAt: 0 };
it("migrates to a new v2 copy and drives document lifecycle through the same authenticated HTTP client", async () => {
  const { call, store } = await start();
  expect((await call("open", { projectId: "mcp-work", project: await fixture() })).isError).toBe(false);
  const migrated = await call("migrate_copy", { projectId: "mcp-v2", sourceProjectId: "mcp-work" });
  expect(migrated.isError).toBe(false);
  const copy = JSON.parse(migrated.content[0]!.text);
  expect(copy.snapshot.document.version).toBe(2);
  expect(copy.snapshot.document.migration).toMatchObject({ sourceProjectId: "mcp-work" });
  const add = { projectId: "mcp-v2", transactionId: "agent-add", baseRevision: 0, change: { action: "add", objectId: "script", versionId: "script-v1", kind: "script-document", payload: script } };
  const added = await call("lifecycle", add);
  expect(added.isError).toBe(false);
  expect(JSON.parse(added.content[0]!.text)).toMatchObject({ receipt: { transactionId: "agent-add", stage: "verified" }, snapshot: { revision: 1 } });
  expect((await call("lifecycle", add)).isError).toBe(false);
  expect(store.snapshot("mcp-v2").snapshot.revision).toBe(1);
  expect((await call("lifecycle", { ...add, transactionId: "stale-archive", change: { action: "archive", objectId: "script" } })).isError).toBe(true);
  expect(store.snapshot("mcp-v2").snapshot.revision).toBe(1);
  const archived = await call("lifecycle", { projectId: "mcp-v2", transactionId: "agent-archive", baseRevision: 1, change: { action: "archive", objectId: "script" } });
  expect(archived.isError).toBe(false);
  const saved = store.snapshot("mcp-v2").snapshot.document;
  expect(saved.version).toBe(2);
  expect(saved.objects).toEqual(expect.arrayContaining([expect.objectContaining({ id: "script", kind: "script-document", archived: true })]));
  expect(saved.versions).toHaveLength(3);
});