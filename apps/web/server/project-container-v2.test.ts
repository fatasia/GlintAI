import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  migrateDocumentToContainer,
  canonicalProjectJson,
} from "@glintai/scenescript/project-container";
import {
  migrateContainerV2,
  parseUnifiedContainer,
  type ProjectContainerV2,
} from "@glintai/scenescript/project-container-v2";
import {
  appendContainerDocuments,
  containerPayloadDigest,
  createProjectContainerStore,
} from "./project-container-session";
import { changeContainerLifecycle } from "./project-container-v2-lifecycle";
import { dispatchContainerAction } from "./project-container-actions";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
const scene = {
  schemaVersion: 1,
  id: "scene",
  title: "Scene",
  aspect: "16:9",
  knowledgeSources: [],
  scenes: [
    { id: "one", kind: "title", title: "Title", narration: { text: "Text", durationMs: 1000 } },
  ],
};
const script = { id: "script", title: "Script", kind: "script", content: "Original", updatedAt: 0 };
const design = {
  id: "design",
  title: "Slides",
  kind: "slides",
  pages: [{ id: "one", title: "One", html: "<h1>Hello</h1>" }],
  activePageId: "one",
  updatedAt: 0,
};
const tx = (id: string, baseRevision: number) => ({
  id,
  baseRevision,
  actor: "user" as const,
  scope: {},
  intent: "edit",
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-v2-"));
  roots.push(root);
  const source = (
    await migrateDocumentToContainer(scene, {
      kind: "scene-document",
      projectId: "source",
      objectId: "scene",
      versionId: "initial",
      actor: "user",
      transactionId: "import",
    })
  ).container;
  const store = createProjectContainerStore(root),
    project = await migrateContainerV2(source, "work");
  store.open("work", project);
  return { store, project, source, root };
}
const current = (store: ReturnType<typeof createProjectContainerStore>) =>
  store.snapshot("work").snapshot.document as unknown as ProjectContainerV2;
const add = (store: ReturnType<typeof createProjectContainerStore>, revision = 0) =>
  changeContainerLifecycle(store, "work", tx("add", revision), {
    action: "add",
    kind: "script-document",
    objectId: "script",
    versionId: "script-v1",
    payload: script,
  });

it("migrates only to a new copy, preserving source bytes and exact provenance", async () => {
  const { store, source, project } = await setup(),
    original = canonicalProjectJson(source);
  expect(project.migration).toEqual({
    sourceProjectId: "source",
    sourceDigest: containerPayloadDigest(source),
  });
  await expect(migrateContainerV2(source, "source")).rejects.toThrow("new project");
  store.open("source", source);
  const before = fs
    .readdirSync(store.directory)
    .map((file) => [file, fs.readFileSync(path.join(store.directory, file), "utf8")]);
  await dispatchContainerAction(() => store, "migrate-copy", {
    projectId: "copy",
    sourceProjectId: "source",
  });
  for (const [file, bytes] of before)
    expect(fs.readFileSync(path.join(store.directory, file!), "utf8")).toBe(bytes);
  expect(canonicalProjectJson(source)).toBe(original);
});
it("adds, edits and archives in the same shared revision and history", async () => {
  const { store, root } = await setup();
  expect(add(store).receipt.stage).toBe("verified");
  expect(add(store).receipt.stage).toBe("verified");
  expect(
    changeContainerLifecycle(store, "work", tx("add", 0), {
      action: "add",
      kind: "script-document",
      objectId: "script",
      versionId: "script-v1",
      payload: { ...script, content: "Other" },
    }).receipt.stage,
  ).toBe("refused");
  expect(
    appendContainerDocuments(store, "work", tx("edit", 1), [
      { objectId: "script", versionId: "script-v2", payload: { ...script, content: "Changed" } },
    ]).receipt.stage,
  ).toBe("verified");
  expect(
    changeContainerLifecycle(store, "work", tx("archive", 2), {
      action: "archive",
      objectId: "script",
    }).receipt.stage,
  ).toBe("verified");
  expect(() =>
    appendContainerDocuments(store, "work", tx("bad", 3), [
      { objectId: "script", versionId: "bad", payload: script },
    ]),
  ).toThrow("active");
  const reopened = createProjectContainerStore(root);
  expect(reopened.historyEdit("work", "undo", "undo", 3, "user").receipt.stage).toBe("verified");
  expect(current(reopened).objects[1]!.archived).toBe(false);
  expect(current(reopened).versions).toHaveLength(3);
  expect(reopened.historyEdit("work", "redo", "redo", 4, "user").receipt.stage).toBe("verified");
  expect(current(reopened).objects[1]!.archived).toBe(true);
});
it("undoing creation archives IDs and versions, redo restores them, forks cannot reuse IDs", async () => {
  const { store } = await setup();
  add(store);
  expect(store.historyEdit("work", "undo", "undo", 1, "user").receipt.stage).toBe("verified");
  expect(current(store).objects[1]).toMatchObject({ id: "script", archived: true });
  expect(current(store).versions).toHaveLength(2);
  expect(store.historyEdit("work", "redo", "redo", 2, "cli").receipt.stage).toBe("verified");
  expect(current(store).objects[1]!.archived).toBe(false);
  store.historyEdit("work", "undo", "undo-again", 3, "user");
  expect(() =>
    changeContainerLifecycle(store, "work", tx("reuse", 4), {
      action: "add",
      kind: "script-document",
      objectId: "script",
      versionId: "new",
      payload: script,
    }),
  ).toThrow("identities");
  expect(
    changeContainerLifecycle(store, "work", tx("restore", 4), {
      action: "restore",
      objectId: "script",
    }).receipt.stage,
  ).toBe("verified");
});
it("rejects stale writers, unknown payload fields, changed identities and the last archive", async () => {
  const { store, project } = await setup();
  add(store);
  expect(
    changeContainerLifecycle(store, "work", tx("stale", 0), {
      action: "archive",
      objectId: "scene",
    }).receipt.stage,
  ).toBe("refused");
  expect(
    appendContainerDocuments(store, "work", tx("extra", 1), [
      { objectId: "script", versionId: "extra", payload: { ...script, execute: "anything" } },
    ]).receipt.stage,
  ).toBe("refused");
  expect(
    appendContainerDocuments(store, "work", tx("id", 1), [
      { objectId: "script", versionId: "id", payload: { ...script, id: "different" } },
    ]).receipt.stage,
  ).toBe("refused");
  const only = createProjectContainerStore(path.join(store.directory, "only"));
  only.open("work", project);
  expect(
    changeContainerLifecycle(only, "work", tx("last", 0), { action: "archive", objectId: "scene" })
      .receipt.stage,
  ).toBe("refused");
  expect(current(only)).toEqual(project);
});
it("keeps v1 lifecycle disabled and rejects silent same-ID format changes", async () => {
  const { store, source } = await setup();
  store.open("source", source);
  expect(() =>
    changeContainerLifecycle(store, "source", tx("bad", 0), {
      action: "archive",
      objectId: "scene",
    }),
  ).toThrow("new v2 copy");
  expect(
    store.applyTransform("source", tx("upgrade", 0), () => [
      { kind: "set", path: ["version"], value: 2 },
      { kind: "set", path: ["objects"], value: [{ ...source.objects[0]!, archived: false }] },
    ]).receipt.stage,
  ).toBe("refused");
});
it("validates designs, rejects forged approvals and preserves frozen documents", async () => {
  const { store } = await setup();
  expect(
    changeContainerLifecycle(store, "work", tx("design", 0), {
      action: "add",
      kind: "design-document",
      objectId: "design",
      versionId: "design-v1",
      payload: design,
    }).receipt.stage,
  ).toBe("verified");
  expect(
    changeContainerLifecycle(store, "work", tx("forge", 1), {
      action: "add",
      kind: "scene-document",
      objectId: "forged",
      versionId: "forged-v1",
      payload: { ...scene, frozen: true },
    }).receipt.stage,
  ).toBe("refused");
  const bad = structuredClone(current(store));
  bad.versions[1]!.payload = { ...design, activePageId: "missing" };
  bad.versions[1]!.contentDigest = containerPayloadDigest(bad.versions[1]!.payload);
  await expect(parseUnifiedContainer(bad)).rejects.toThrow();
  const freeze = appendContainerDocuments(store, "work", tx("freeze", 1), [
    {
      objectId: "scene",
      versionId: "frozen",
      payload: { ...(current(store).versions[0]!.payload as object), frozen: true },
    },
  ]);
  expect(freeze.receipt.stage).toBe("verified");
  expect(
    changeContainerLifecycle(store, "work", tx("archive", 2), {
      action: "archive",
      objectId: "scene",
    }).receipt.stage,
  ).toBe("refused");
});

const asset = {
  id: "hero",
  kind: "character",
  name: "Hero",
  version: "v1",
  description: "Blue",
  voice: "voice",
  refs: ["assets/hero.png"],
};
const approval = {
  name: asset.name,
  version: asset.version,
  description: asset.description,
  voice: asset.voice,
  refs: asset.refs,
};
it("add and copy paths cannot forge approvals or inherit frozen state", async () => {
  const { store, source } = await setup();
  const approvedScene = { ...scene, assets: [{ ...asset, approval }] };
  const approvedCopy = await migrateContainerV2(
    await migrateDocumentToContainer(approvedScene, {
      kind: "scene-document",
      projectId: "approved",
      objectId: "scene",
      versionId: "approved-v1",
      actor: "user",
      transactionId: "import",
    }).then((pair) => pair.container),
    "approved-v2",
  );
  expect(() => store.open("approved-v2", approvedCopy)).toThrow("approvals");
  const frozenCopy = await migrateContainerV2(
    await migrateDocumentToContainer({ ...scene, frozen: true }, {
      kind: "scene-document",
      projectId: "frozen",
      objectId: "scene",
      versionId: "frozen-v1",
      actor: "user",
      transactionId: "import",
    }).then((pair) => pair.container),
    "frozen-v2",
  );
  expect(() => store.open("frozen-v2", frozenCopy)).toThrow("frozen");
  expect(
    changeContainerLifecycle(store, "work", tx("forge-approval", 0), {
      action: "add",
      kind: "scene-document",
      objectId: "forged-approval",
      versionId: "forged-approval-v1",
      payload: approvedScene,
    }).receipt.stage,
  ).toBe("refused");
  expect(store.snapshot("work").snapshot.revision).toBe(0);
});
