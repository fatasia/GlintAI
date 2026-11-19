import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { canonicalProjectJson, migrateDocumentsToContainer, parseProjectContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "./project-container-session";
import { createWebServer } from "./index.mjs";
import { readContainer } from "../src/container-workspace-client";

it("exports every saved document/version/archive and reopens unchanged in isolated storage with the same identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-export-")), servers: Server[] = [];
  const scene = { schemaVersion: 1, id: "original-scene", title: "Scene", aspect: "16:9", knowledgeSources: [], migrationNote: "retain unknown source metadata", scenes: [{ id: "s", kind: "title", title: "Title", narration: { text: "Text", durationMs: 1000 } }] };
  const timeline = { schemaVersion: 1, id: "original-nle", title: "Timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "c", kind: "text", text: "Caption", startMs: 0, durationMs: 1000 }] }] };
  const sourceFile = path.join(root, "scene.json"), originalBytes = Buffer.from(JSON.stringify(scene, null, 2) + "\n"); fs.writeFileSync(sourceFile, originalBytes);
  const digest = (value: unknown) => createHash("sha256").update(canonicalProjectJson(value)).digest("hex");
  const start = async (name: string) => {
    const store = createProjectContainerStore(path.join(root, name));
    const server = createWebServer({ projectContainerStoreFactory: () => store, requestLogDir: path.join(root, `${name}-logs`) }) as Server; servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { store, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const post = (origin: string, action: string, body: unknown) => fetch(`${origin}/api/project-containers/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const { container } = await migrateDocumentsToContainer([
      { kind: "scene-document", input: JSON.parse(fs.readFileSync(sourceFile, "utf8")), objectId: "scene", versionId: "s1" },
      { kind: "timeline-document", input: timeline, objectId: "timeline", versionId: "t1" },
    ], { projectId: "export-work", actor: "user", transactionId: "import" });
    const source = await start("source"), target = await start("target");
    expect((await post(source.origin, "open", { projectId: container.id, project: container, createOnly: true })).status).toBe(200);
    expect((await post(source.origin, "append", { projectId: container.id, transaction: { id: "edit", baseRevision: 0, actor: "user", scope: {}, intent: "Change both documents" }, changes: [
      { objectId: "scene", versionId: "s2", payload: { ...(container.versions[0]!.payload as object), title: "Saved scene" } },
      { objectId: "timeline", versionId: "t2", payload: { ...timeline, title: "Saved timeline" } },
    ] })).status).toBe(200);
    expect((await post(source.origin, "undo", { projectId: container.id, transactionId: "undo", baseRevision: 1, actor: "user" })).status).toBe(200);
    expect((await post(source.origin, "redo", { projectId: container.id, transactionId: "redo", baseRevision: 2, actor: "user" })).status).toBe(200);
    const before = source.store.snapshot(container.id);
    const exported = await readContainer(container.id, undefined, (url, init) => fetch(`${source.origin}${url}`, init));
    expect(exported.look.revision).toBe(3); expect(exported.container.versions).toHaveLength(4); expect(exported.container.objects).toHaveLength(2);
    const bytes = JSON.stringify(exported.container, null, 2), parsed = await parseProjectContainer(JSON.parse(bytes));
    expect(parsed).toEqual(before.snapshot.document);
    expect(parsed.versions.slice(0, 2).map(version => digest(version.archive))).toEqual(container.versions.map(version => digest(version.archive)));
    expect(parsed.versions.slice(0, 2).map(version => version.contentDigest)).toEqual(container.versions.map(version => version.contentDigest));
    expect(parsed.versions.filter(version => version.parentVersionId).map(version => version.parentVersionId)).toEqual(["s1", "t1"]);
    const opened = await post(target.origin, "open", { projectId: parsed.id, project: parsed, createOnly: true }); expect(opened.status).toBe(200);
    expect((await opened.json()).snapshot.document).toEqual(parsed);
    // Never rename a historical container just to bypass createOnly collision handling.
    expect((await post(target.origin, "open", { projectId: parsed.id, project: parsed, createOnly: true })).status).toBe(409);
    expect(target.store.snapshot(parsed.id).snapshot.document).toEqual(parsed);
    expect(source.store.snapshot(parsed.id)).toEqual(before); expect(fs.readFileSync(sourceFile)).toEqual(originalBytes);
    const damaged = JSON.parse(bytes); damaged.versions[0].archive.original.title = "Tampered archive";
    await expect(parseProjectContainer(damaged)).rejects.toThrow();
    damaged.versions[0] = { ...parsed.versions[0], contentDigest: "0".repeat(64) };
    await expect(parseProjectContainer(damaged)).rejects.toThrow();
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
