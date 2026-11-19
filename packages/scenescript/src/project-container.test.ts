import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseProject } from "./parse";
import { parseNleProject } from "./nle";
import { appendProjectVersions, canonicalProjectJson, migrateDocumentsToContainer, migrateDocumentToContainer, parseProjectContainer,
  projectContentDigest, parseProjectContainerWithDigest, type ProjectContainer, type ProjectVersion } from "./project-container";

const scene = {
  schemaVersion: 1, id: "original", title: "Original", language: "zh-CN", aspect: "16:9", theme: "chalk",
  knowledgeSources: [], scenes: [{ id: "same-local-id", kind: "title", title: "Keep me",
    narration: { text: "Keep me", durationMs: 3000 },
    elements: [{ id: "shape", kind: "rect", x: 0.2, y: 0.3, w: 0.4, h: 0.1, fill: "#ffffff" }],
    tracks: [{ elementId: "shape", property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: 900, value: 1 }] }],
  }],
};
const timeline = {
  schemaVersion: 1, id: "original", title: "Timeline", fps: 30, width: 1920, height: 1080,
  tracks: [{ id: "same-local-id", kind: "video", name: "Video", clips: [{ id: "clip", kind: "video",
    src: "assets/clip.mp4", startMs: 1000, durationMs: 3000, trimStartMs: 400, speed: 1.5,
    keyframes: [{ ms: 0, x: 0 }, { ms: 1000, x: 0.2 }],
  }] }],
};
const options = { kind: "scene-document" as const, projectId: "work", objectId: "doc", versionId: "v1", actor: "author", transactionId: "tx1" };
const fixture = async () => (await migrateDocumentToContainer(scene, options)).container;
it("uses identical structural and digest checks in the synchronous locked-store adapter", async () => {
  const original = await fixture();
  const sha = (value: unknown) => createHash("sha256").update(canonicalProjectJson(value)).digest("hex");
  expect(parseProjectContainerWithDigest(original, sha)).toEqual(await parseProjectContainer(original));
  expect(() => parseProjectContainerWithDigest(original, () => "bad")).toThrow("digest");
  const corrupt = structuredClone(original); corrupt.versions[0]!.contentDigest = "0".repeat(64);
  expect(() => parseProjectContainerWithDigest(corrupt, sha)).toThrow("digest");
  await expect(parseProjectContainer(corrupt)).rejects.toThrow("digest");
  expect(() => parseProjectContainerWithDigest({ ...original, version: 2 }, sha)).toThrow();
});
async function version(id: string, objectId: string, payload: unknown, extra: Partial<ProjectVersion> = {}): Promise<ProjectVersion> {
  return { id, objectId, payload, contentDigest: await projectContentDigest(payload), sources: [], references: [], actor: "author", transactionId: "tx2", ...extra };
}

describe("explicit document migration", () => {
  it("preserves SceneScript IDs, elements, timing and raw JSON without mutating the original", async () => {
    const original = structuredClone(scene);
    const result = await migrateDocumentToContainer(scene, options);
    expect(result.container.versions[0]!.payload).toEqual(parseProject(scene));
    expect(result.container.versions[0]!.archive!.original).toEqual(original);
    expect(result.container.id).toBe("work");
    expect(scene).toEqual(original);
    expect(await parseProjectContainer(JSON.parse(JSON.stringify(result.container)))).toEqual(result.container);
    (result.container.versions[0]!.archive!.original as typeof scene).scenes[0]!.title = "changed";
    expect(scene.scenes[0]!.title).toBe("Keep me");
  });

  it("preserves NLE track/clip IDs, paths, positions, trim and keyframes", async () => {
    const result = await migrateDocumentToContainer(timeline, { ...options, kind: "timeline-document" });
    expect(result.container.versions[0]!.payload).toEqual(parseNleProject(timeline));
    expect(result.container.versions[0]!.archive!.original).toEqual(timeline);
    expect(await parseProjectContainer(JSON.parse(JSON.stringify(result.container)))).toEqual(result.container);
  });

  it("archives unknown SceneScript fields and names their paths rather than silently dropping them", async () => {
    const raw = { ...scene, extension: { custom: 42 }, scenes: [{ ...scene.scenes[0], future: true }] };
    const { container, diagnostics } = await migrateDocumentToContainer(raw, options);
    expect(container.versions[0]!.archive!.original).toEqual(raw);
    expect(diagnostics).toEqual(expect.arrayContaining(["Archived unsupported field: $.extension", "Archived unsupported field: $.scenes.0.future"]));
    expect(container.versions[0]!.payload).not.toHaveProperty("extension");
    expect(await parseProjectContainer(container)).toEqual(container);
  });

  it("does not weaken the existing strict NLE parser or guess the document kind", async () => {
    const raw = { ...timeline, future: true };
    await expect(migrateDocumentToContainer(raw, { ...options, kind: "timeline-document" })).rejects.toThrow();
    expect(raw.future).toBe(true);
    await expect(migrateDocumentToContainer(timeline, options)).rejects.toThrow();
    await expect(migrateDocumentToContainer(scene, { ...options, kind: "timeline-document" })).rejects.toThrow();
  });

  it.each([0, 2, undefined])("rejects non-current schemaVersion %s", async schemaVersion => {
    await expect(migrateDocumentToContainer({ ...scene, schemaVersion }, options)).rejects.toThrow();
  });

  it("rejects future containers and unknown envelope keys", async () => {
    const c = await fixture();
    await expect(parseProjectContainer({ ...c, version: 2 })).rejects.toThrow();
    await expect(parseProjectContainer({ ...c, unrecognized: true })).rejects.toThrow();
  });
});

describe("pinned graph and content", () => {
  it("verifies canonical SHA-256 independently of key order", async () => {
    expect(canonicalProjectJson({ z: [2, 1], a: 1 })).toBe('{"a":1,"z":[2,1]}');
    expect(await projectContentDigest({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(await projectContentDigest({ b: 2, a: 1 })).toBe(await projectContentDigest({ a: 1, b: 2 }));
  });

  it.each([undefined, NaN, Infinity, new Date(), [undefined], new Array(2), { a: undefined }])("rejects lossy non-JSON data %#", value => {
    expect(() => canonicalProjectJson(value)).toThrow();
  });

  it("rejects circular JSON and does not execute accessors", () => {
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic;
    expect(() => canonicalProjectJson(cyclic)).toThrow();
    let called = false;
    const getter = { get value() { called = true; return 1; } };
    expect(() => canonicalProjectJson(getter)).toThrow();
    const array = [1]; Object.defineProperty(array, "0", { get() { called = true; return 1; } });
    expect(() => canonicalProjectJson(array)).toThrow();
    expect(called).toBe(false);
  });

  it("rejects tampered document content, digest, archive and unnormalized payload", async () => {
    const c = await fixture();
    for (const mutate of [
      (v: ProjectVersion) => { (v.payload as { title: string }).title = "tampered"; },
      (v: ProjectVersion) => { v.contentDigest = "0".repeat(64); },
      (v: ProjectVersion) => { (v.archive!.original as { title: string }).title = "different"; },
      (v: ProjectVersion) => { (v.payload as Record<string, unknown>).extra = true; },
    ]) {
      const bad = structuredClone(c); mutate(bad.versions[0]!);
      await expect(parseProjectContainer(bad)).rejects.toThrow();
    }
  });

  it("checks duplicate IDs, ownership, current, parent, source and content references", async () => {
    const c = await fixture();
    const mutations: ((c: ProjectContainer) => void)[] = [
      c => { c.objects.push(structuredClone(c.objects[0]!)); },
      c => { c.versions.push(structuredClone(c.versions[0]!)); },
      c => { c.versions[0]!.objectId = "missing"; },
      c => { c.objects[0]!.currentVersionId = "missing"; },
      c => { c.versions[0]!.parentVersionId = "missing"; },
      c => { c.versions[0]!.sources = [{ objectId: "doc", versionId: "missing" }]; },
      c => { c.versions[0]!.references = [{ objectId: "wrong-owner", versionId: "v1" }]; },
    ];
    for (const mutate of mutations) { const bad = structuredClone(c); mutate(bad); await expect(parseProjectContainer(bad)).rejects.toThrow(); }
  });

  it("rejects parent cycles, source cycles and cycles mixing the two", async () => {
    const c = await fixture();
    const v2 = await version("v2", "doc", c.versions[0]!.payload, { parentVersionId: "v1" });
    for (const edge of ["parent", "source", "reference"]) {
      const bad = structuredClone(c); bad.versions.push(v2);
      if (edge === "parent") bad.versions[0]!.parentVersionId = "v2";
      else if (edge === "source") bad.versions[0]!.sources = [{ objectId: "doc", versionId: "v2" }];
      else bad.versions[0]!.references = [{ objectId: "doc", versionId: "v2" }];
      await expect(parseProjectContainer(bad)).rejects.toThrow(/cycle/);
    }
    c.versions[0]!.sources = [{ objectId: "doc", versionId: "v1" }];
    await expect(parseProjectContainer(c)).rejects.toThrow(/cycle/);
  });

  it("permits independent documents with identical local IDs and rejects cross-object parents", async () => {
    const c = await fixture();
    const second = await migrateDocumentToContainer(timeline, { ...options, kind: "timeline-document", objectId: "timeline", versionId: "t1" });
    const combined = await appendProjectVersions(c, { objects: second.container.objects, versions: second.container.versions });
    expect((combined.versions[0]!.payload as { id: string }).id).toBe("original");
    expect((combined.versions[1]!.payload as { id: string }).id).toBe("original");
    combined.versions[1]!.parentVersionId = "v1";
    await expect(parseProjectContainer(combined)).rejects.toThrow(/reference/);
  });

  it("rejects cross-object source cycles without forbidding pinned earlier versions", async () => {
    const c = await fixture();
    const brief = await version("r1", "brief", { text: "Brief" }, { sources: [{ objectId: "doc", versionId: "v1" }] });
    const combined = await appendProjectVersions(c, { objects: [{ id: "brief", kind: "reference-document", currentVersionId: "r1" }], versions: [brief] });
    combined.versions[0]!.sources = [{ objectId: "brief", versionId: "r1" }];
    await expect(parseProjectContainer(combined)).rejects.toThrow(/cycle/);
    combined.versions[0]!.sources = [];
    const next = await version("v2", "doc", { ...parseProject(scene), title: "New" }, { parentVersionId: "v1" });
    const advanced = await appendProjectVersions(combined, { versions: [next], current: [{ objectId: "doc", versionId: "v2" }] });
    expect(advanced.versions[1]!.sources).toEqual([{ objectId: "doc", versionId: "v1" }]);
  });

  it("checks non-document digests and preserves asset byte verification as pending", async () => {
    const c = await fixture(), hash = "a".repeat(64);
    const asset = await version("a1", "asset", { path: "assets/a.mp4", bytes: 50, sha256: hash, verification: "pending-bytes" }, { contentDigest: hash });
    const generation = await version("g1", "candidate", { receiptId: "receipt1" }, { references: [{ objectId: "asset", versionId: "a1" }] });
    const reference = await version("r1", "brief", { title: "Brief" });
    const combined = await appendProjectVersions(c, { objects: [
      { id: "asset", kind: "asset", currentVersionId: "a1" }, { id: "candidate", kind: "generation-result", currentVersionId: "g1" },
      { id: "brief", kind: "reference-document", currentVersionId: "r1" },
    ], versions: [asset, generation, reference] });
    expect(combined.objects[0]!.currentVersionId).toBe("v1");
    expect(combined.versions[1]!.payload).toHaveProperty("verification", "pending-bytes");
    for (const index of [2, 3]) {
      const bad = structuredClone(combined); bad.versions[index]!.contentDigest = hash;
      await expect(parseProjectContainer(bad)).rejects.toThrow(/digest/);
    }
    for (const change of [{ verification: "verified" }, { path: "../private.mp4" }, { sha256: "b".repeat(64) }]) {
      const bad = structuredClone(combined); Object.assign(bad.versions[1]!.payload as object, change);
      await expect(parseProjectContainer(bad)).rejects.toThrow();
    }
  });
});

describe("immutable append and pointer selection", () => {
  it("keeps history on undo and branch and never mutates input or incoming versions", async () => {
    const c = await fixture(), before = structuredClone(c);
    const v2 = await version("v2", "doc", { ...parseProject(scene), title: "Second" }, { parentVersionId: "v1" });
    const next = await appendProjectVersions(c, { versions: [v2], current: [{ objectId: "doc", versionId: "v2" }] });
    expect(c).toEqual(before);
    const undo = await appendProjectVersions(next, { versions: [], current: [{ objectId: "doc", versionId: "v1" }] });
    const v3 = await version("v3", "doc", { ...parseProject(scene), title: "Branch" }, { parentVersionId: "v1" });
    const branch = await appendProjectVersions(undo, { versions: [v3], current: [{ objectId: "doc", versionId: "v3" }] });
    expect(branch.versions.map(v => v.id)).toEqual(["v1", "v2", "v3"]);
    expect(branch.versions[1]).toEqual(v2);
    (branch.versions[1]!.payload as { title: string }).title = "detached";
    expect((v2.payload as { title: string }).title).toBe("Second");
    expect(next.objects[0]!.currentVersionId).toBe("v2");
  });

  it("rejects replacement, object-ID reuse, invalid pointer and document identity change", async () => {
    const c = await fixture();
    await expect(appendProjectVersions(c, { versions: [c.versions[0]!] })).rejects.toThrow(/immutable/);
    await expect(appendProjectVersions(c, { objects: c.objects, versions: [] })).rejects.toThrow(/reuse/);
    await expect(appendProjectVersions(c, { versions: [], current: [{ objectId: "doc", versionId: "no" }] })).rejects.toThrow();
    const v2 = await version("v2", "doc", { ...parseProject(scene), id: "renamed-id" }, { parentVersionId: "v1" });
    await expect(appendProjectVersions(c, { versions: [v2] })).rejects.toThrow(/identity/);
    v2.parentVersionId = "later";
    await expect(appendProjectVersions(c, { versions: [v2] })).rejects.toThrow(/already exist/);
  });
});

describe("explicit multi-document migration", () => {
  const shared = { projectId: "combined", actor: "author", transactionId: "batch" };
  const documents = () => [
    { kind: "scene-document" as const, input: structuredClone(scene), objectId: "scene", versionId: "s1" },
    { kind: "timeline-document" as const, input: structuredClone(timeline), objectId: "timeline", versionId: "t1" },
  ];
  it("preserves both documents, raw archives and independent version updates in one container", async () => {
    const inputs = documents(), before = structuredClone(inputs);
    const { container, diagnostics } = await migrateDocumentsToContainer(inputs, shared);
    expect(inputs).toEqual(before);
    expect(container.id).toBe("combined");
    expect(container.objects.map(o => o.kind)).toEqual(["scene-document", "timeline-document"]);
    expect(container.versions.map(v => v.payload)).toEqual([parseProject(scene), parseNleProject(timeline)]);
    expect(container.versions.map(v => v.archive!.original)).toEqual([scene, timeline]);
    expect(container.versions.map(v => [v.actor, v.transactionId, v.sources, v.references])).toEqual([
      ["author", "batch", [], []], ["author", "batch", [], []],
    ]);
    expect(diagnostics).toEqual([]);
    expect(await parseProjectContainer(JSON.parse(JSON.stringify(container)))).toEqual(container);
    const next = await appendProjectVersions(container, { versions: [await version("s2", "scene", { ...parseProject(scene), title: "Edited" }, { parentVersionId: "s1" })], current: [{ objectId: "scene", versionId: "s2" }] });
    expect(next.objects.map(o => o.currentVersionId)).toEqual(["s2", "t1"]);
    expect(next.versions[1]).toEqual(container.versions[1]);
    expect(container.objects[0]!.currentVersionId).toBe("s1");
    (container.versions[0]!.archive!.original as typeof scene).title = "detached";
    expect(inputs).toEqual(before);
  });
  it("retains original diagnostics in archives and labels aggregate diagnostics", async () => {
    const input = { ...scene, extension: 42 };
    const { container, diagnostics } = await migrateDocumentsToContainer([{ kind: "scene-document", input, objectId: "scene", versionId: "s1" }], shared);
    expect(container.versions[0]!.archive!.diagnostics).toEqual(["Archived unsupported field: $.extension"]);
    expect(container.versions[0]!.archive!.original).toEqual(input);
    expect(diagnostics).toEqual(["[scene] Archived unsupported field: $.extension"]);
  });
  it("snapshots the whole batch before asynchronous migration", async () => {
    const inputs = documents();
    const pending = migrateDocumentsToContainer(inputs, shared);
    inputs[1]!.input.title = "Changed during hashing";
    const { container } = await pending;
    expect(container.versions[1]!.payload).toEqual(parseNleProject(timeline));
  });
  it("accepts 100 documents and rejects empty or oversized batches", async () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({ kind: "scene-document" as const, input: scene, objectId: `doc-${i}`, versionId: `v-${i}` }));
    expect((await migrateDocumentsToContainer(batch, shared)).container.objects).toHaveLength(100);
    await expect(migrateDocumentsToContainer([], shared)).rejects.toThrow("1..100");
    await expect(migrateDocumentsToContainer([...batch, batch[0]!], shared)).rejects.toThrow("1..100");
  });
  it("rejects duplicate IDs, wrong kind, source version and invalid documents atomically", async () => {
    const inputs = documents();
    await expect(migrateDocumentsToContainer([inputs[0]!, { ...inputs[1]!, objectId: "scene" }], shared)).rejects.toThrow("Duplicate object");
    await expect(migrateDocumentsToContainer([inputs[0]!, { ...inputs[1]!, versionId: "s1" }], shared)).rejects.toThrow("Duplicate version");
    for (const input of [{ ...timeline, schemaVersion: 2 }, {}, { ...timeline, extra: true }, scene]) {
      await expect(migrateDocumentsToContainer([inputs[0]!, { ...inputs[1]!, input }], shared)).rejects.toThrow();
    }
    // Exercise untyped JSON callers without weakening the public TypeScript signature.
    await expect(migrateDocumentsToContainer(JSON.parse(JSON.stringify([{ ...inputs[0], kind: "asset" }])), shared)).rejects.toThrow();
    expect(inputs).toEqual(documents());
  });
});
