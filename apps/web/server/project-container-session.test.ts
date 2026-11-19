import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { canonicalJson, type EditTransaction } from "@glintai/session";
import { migrateDocumentToContainer, parseProjectContainer, parseProjectContainerWithDigest, type ProjectContainer } from "@glintai/scenescript/project-container";
import { appendContainerDocuments, containerPayloadDigest, createProjectContainerStore } from "./project-container-session";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-session-")); roots.push(root); return root; };
const scene = { schemaVersion: 1, id: "scene", title: "Original", language: "zh-CN", aspect: "16:9", theme: "chalk", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Original", narration: { text: "Original", durationMs: 1000 } }] };
const timeline = { schemaVersion: 1, id: "nle", title: "Timeline", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "clip", kind: "text", text: "Original", startMs: 0, durationMs: 1000 }] }] };
async function fixture(extra: Record<string, unknown> = {}) {
  const a = (await migrateDocumentToContainer({ ...scene, ...extra }, { kind: "scene-document", projectId: "work", objectId: "scene-doc", versionId: "scene-v1", actor: "user", transactionId: "import" })).container;
  const b = (await migrateDocumentToContainer(timeline, { kind: "timeline-document", projectId: "work", objectId: "nle-doc", versionId: "nle-v1", actor: "user", transactionId: "import" })).container;
  a.versions[0]!.references = [{ objectId: "nle-doc", versionId: "nle-v1" }];
  return parseProjectContainer({ ...a, objects: [...a.objects, ...b.objects], versions: [...a.versions, ...b.versions] });
}
const request = (id: string, baseRevision: number) => ({ id, baseRevision, actor: "user" as const, scope: {}, intent: "edit" });
const container = (store: FileSessionStore) => store.snapshot("work").snapshot.document as unknown as ProjectContainer;
const change = (c: ProjectContainer, objectId = "scene-doc", versionId = "scene-v2", title = "Changed") => {
  const object = c.objects.find(object => object.id === objectId)!;
  return { objectId, versionId, payload: { ...(c.versions.find(version => version.id === object.currentVersionId)!.payload as Record<string, unknown>), title } };
};
const stateFile = (dir: string) => path.join(dir, `${createHash("sha256").update("work").digest("hex")}.json`);

it("commits two documents atomically, retries exactly and preserves versions through undo/redo/reopen/fork", async () => {
  const dir = directory(), first = await fixture(), store = createProjectContainerStore(dir);
  store.open("work", first);
  const edits = [change(first), change(first, "nle-doc", "nle-v2")];
  const saved = appendContainerDocuments(store, "work", request("edit", 0), edits);
  expect(saved.receipt.stage).toBe("verified"); expect(saved.snapshot.revision).toBe(1);
  expect(container(store).versions.find(version => version.id === "scene-v2")!.references).toEqual(first.versions[0]!.references);
  expect(appendContainerDocuments(store, "work", request("edit", 0), edits).receipt).toEqual(saved.receipt);
  expect(appendContainerDocuments(store, "work", request("edit", 0), [change(first, "scene-doc", "scene-v2", "Other")]).receipt.stage).toBe("refused");
  expect(store.historyEdit("work", "undo", "undo", 1, "user").receipt.stage).toBe("verified");
  expect(container(store).versions).toHaveLength(4);
  expect(container(store).objects.map(object => object.currentVersionId)).toEqual(["scene-v1", "nle-v1"]);
  const reopened = createProjectContainerStore(dir);
  expect(reopened.historyEdit("work", "redo", "redo", 2, "cli").receipt.stage).toBe("verified");
  expect(container(reopened).versions).toHaveLength(4);
  expect(container(reopened).objects.map(object => object.currentVersionId)).toEqual(["scene-v2", "nle-v2"]);
  reopened.historyEdit("work", "undo", "undo-again", 3, "user");
  expect(appendContainerDocuments(reopened, "work", request("fork", 4), [change(container(reopened), "scene-doc", "scene-v3", "Branch")]).receipt.stage).toBe("verified");
  expect(container(reopened).versions).toHaveLength(5);
  expect(container(reopened).versions.at(-1)!.parentVersionId).toBe("scene-v1");
  expect(reopened.historyEdit("work", "redo", "stale-redo", 5, "user").receipt.stage).toBe("refused");
  expect(createProjectContainerStore(dir).verify("work", "edit").stage).toBe("saved");
});

it("rolls back a bad second document, forbids immutable mutations and rejects stale writers", async () => {
  const dir = directory(), first = await fixture(), a = createProjectContainerStore(dir), b = createProjectContainerStore(dir); a.open("work", first);
  const original = fs.readFileSync(stateFile(dir));
  expect(appendContainerDocuments(a, "work", request("bad", 0), [change(first), { objectId: "nle-doc", versionId: "nle-bad", payload: {} }]).receipt.stage).toBe("refused");
  expect(fs.readFileSync(stateFile(dir))).toEqual(original);
  for (const operations of [[{ kind: "delete", path: ["versions", "0"] }], [{ kind: "set", path: ["versions", "0", "actor"], value: "attacker" }], [{ kind: "delete", path: ["objects", "0"] }]]) {
    expect(a.apply("work", { ...request("invalid", 0), projectId: "work", operations } as EditTransaction).receipt.stage).toBe("refused");
    expect(fs.readFileSync(stateFile(dir))).toEqual(original);
  }
  appendContainerDocuments(a, "work", request("one", 0), [change(first)]);
  expect(appendContainerDocuments(b, "work", request("two", 0), [change(first, "nle-doc", "nle-v2")]).receipt.stage).toBe("refused");
  expect(container(b).versions).toHaveLength(3);
});

it("uses real writer locks and recovers committed projection after interruption", async () => {
  const dir = directory(), first = await fixture(), file = path.join(dir, "project.json"); fs.writeFileSync(file, JSON.stringify(first));
  const store = createProjectContainerStore(dir, () => { throw new Error("after-commit interruption"); }); store.open("work", first, file);
  const lock = `${stateFile(dir)}.lock`; fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  expect(() => appendContainerDocuments(store, "work", request("edit", 0), [change(first)])).toThrow("another process"); fs.unlinkSync(lock);
  expect(() => appendContainerDocuments(store, "work", request("edit", 0), [change(first)])).toThrow("after-commit");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(first);
  const recovered = createProjectContainerStore(dir); expect(recovered.snapshot("work").snapshot.revision).toBe(1);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).versions).toHaveLength(3);
  expect(appendContainerDocuments(recovered, "work", request("edit", 0), [change(first)]).receipt.stage).toBe("verified");
  fs.writeFileSync(file, JSON.stringify({ ...first, id: "external" }));
  expect(() => recovered.historyEdit("work", "undo", "undo", 1, "user")).toThrow("changed outside");
});

it("rejects content corruption even with a recomputed session envelope checksum", async () => {
  const dir = directory(), first = await fixture(), store = createProjectContainerStore(dir); store.open("work", first);
  const file = stateFile(dir), envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  envelope.state.document.versions[0].payload.title = "Tampered";
  envelope.checksum = createHash("sha256").update(canonicalJson(envelope.state)).digest("hex"); fs.writeFileSync(file, JSON.stringify(envelope));
  expect(() => createProjectContainerStore(dir).snapshot("work")).toThrow("validation failed");
  expect(() => parseProjectContainerWithDigest(envelope.state.document, containerPayloadDigest)).toThrow();
});

const asset = { id: "hero", kind: "character", name: "Hero", version: "v1", description: "Blue", voice: "voice", refs: ["assets/hero.png"] };
const approval = { name: asset.name, version: asset.version, description: asset.description, voice: asset.voice, refs: asset.refs };
it("rejects imported nested approvals and newly forged approvals without dropping original data", async () => {
  const dir = directory(), approved = await fixture({ assets: [{ ...asset, approval }] }), store = createProjectContainerStore(dir);
  const original = structuredClone(approved);
  expect(() => store.open("work", approved)).toThrow("approvals");
  expect(approved).toEqual(original); expect(fs.existsSync(stateFile(dir))).toBe(false);
  const first = await fixture({ assets: [asset] }); store.open("work", first);
  const edit = change(first); edit.payload.assets = [{ ...asset, approval }];
  expect(appendContainerDocuments(store, "work", request("forged", 0), [edit]).receipt.stage).toBe("refused");
  expect(store.snapshot("work").snapshot.revision).toBe(0);
});

it("preserves legacy approved assets and frozen documents on append and history pointer changes", async () => {
  const dir = directory(), first = await fixture({ assets: [{ ...asset, approval }] });
  // Fixture represents a previously trusted durable session, not the new untrusted open API.
  new FileSessionStore(dir).open("work", first);
  const store = createProjectContainerStore(dir), edit = change(first); edit.payload.assets = [{ ...asset, description: "Changed" }];
  expect(appendContainerDocuments(store, "work", request("change-approved", 0), [edit]).receipt.stage).toBe("refused");
  const frozenDir = directory(), frozen = await fixture({ frozen: true }), frozenStore = createProjectContainerStore(frozenDir); frozenStore.open("work", frozen);
  expect(appendContainerDocuments(frozenStore, "work", request("frozen", 0), [change(frozen)]).receipt.stage).toBe("refused");
  const unfreeze = change(frozen); unfreeze.payload.frozen = false;
  expect(appendContainerDocuments(frozenStore, "work", request("unfreeze", 0), [unfreeze]).receipt.stage).toBe("refused");
});

it.each(["character", "product"])("refuses a current-pointer bypass of legacy approved %s assets", async kind => {
  const dir = directory(), first = await fixture({ assets: [{ ...asset, kind, approval }] });
  const older = await fixture({ assets: [{ ...asset, kind }] });
  const oldVersion = { ...older.versions[0]!, id: "before-approval" };
  first.versions.push(oldVersion);
  new FileSessionStore(dir).open("work", first);
  const store = createProjectContainerStore(dir);
  expect(store.apply("work", { ...request("pointer-bypass", 0), projectId: "work", operations: [{ kind: "set", path: ["objects", "0", "currentVersionId"], value: oldVersion.id }] }).receipt.stage).toBe("refused");
  expect(container(store).objects[0]!.currentVersionId).toBe("scene-v1");
  const valid = change(first, "scene-doc", "scene-v2", "Unrelated title change");
  expect(appendContainerDocuments(store, "work", request("title", 0), [valid]).receipt.stage).toBe("verified");
  expect(store.historyEdit("work", "undo", "undo-title", 1, "user").receipt.stage).toBe("verified");
  expect(container(store).versions).toHaveLength(4);
});

it("rejects nested approval imports even in a non-current archived branch", async () => {
  const first = await fixture(), approved = await fixture({ assets: [{ ...asset, approval }] });
  first.versions.push({ ...approved.versions[0]!, id: "hidden-approved" });
  const dir = directory();
  expect(() => createProjectContainerStore(dir).open("work", first)).toThrow("approvals");
  expect(fs.existsSync(stateFile(dir))).toBe(false);
});

it("refuses an append without its current pointer so every accepted edit has meaningful undo", async () => {
  const first = await fixture(), store = createProjectContainerStore(directory()); store.open("work", first);
  const payload = change(first).payload;
  const orphan = { id: "orphan", objectId: "scene-doc", parentVersionId: "scene-v1", payload, contentDigest: containerPayloadDigest(payload), sources: [], references: [], actor: "user", transactionId: "orphan-edit" };
  const receipt = store.apply("work", { ...request("orphan-edit", 0), projectId: "work", operations: [{ kind: "set", path: ["versions"], value: [...first.versions, orphan] }] }).receipt;
  expect(receipt.stage).toBe("refused");
  expect(store.snapshot("work").look.undoDepth).toBe(0);
  expect(container(store).versions).toHaveLength(2);
});

it.each(["scene-doc", "nle-doc"])("preserves the existing payload identity for %s", async objectId => {
  const first = await fixture(), store = createProjectContainerStore(directory()); store.open("work", first);
  const renamed = change(first, objectId, "new-id-version"); renamed.payload.id = "different-document";
  expect(appendContainerDocuments(store, "work", request("rename-id", 0), [renamed]).receipt.stage).toBe("refused");
  expect(store.snapshot("work").snapshot.revision).toBe(0);
  expect(container(store)).toEqual(first);
});
