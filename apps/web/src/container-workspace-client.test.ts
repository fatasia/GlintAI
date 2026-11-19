import { describe, expect, it, vi } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { assertContainerImportable, importContainerCopy, importContainerPair, readContainer, readContainerList } from "./container-workspace-client";

const source = { schemaVersion: 1, id: "original", title: "Original", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "Hello", durationMs: 1000 } }] };
const reply = (document: unknown, projectId: string) => Response.json({ snapshot: { projectId, document, revision: 0 }, look: { projectId, revision: 0, undoDepth: 0, redoDepth: 0, selection: [], digest: "digest" } });

describe("container import and read adapter", () => {
  it("creates an explicit new container copy while preserving the original document ID and bytes", async () => {
    const before = JSON.stringify(source);
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); expect(body.createOnly).toBe(true); return reply(body.project, body.projectId); });
    const result = await importContainerCopy(source, "scene-document", transport);
    expect(result.container.id).toMatch(/^work-/);
    expect(result.container.versions[0]!.payload).toMatchObject({ id: "original" });
    expect(result.container.versions[0]!.archive!.original).toEqual(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(transport.mock.calls[0]![0]).toBe("/api/project-containers/open");
  });

  it.each([{ ...source, frozen: true }, { ...source, assets: [{ approval: { version: "v1" } }] }, { archive: { original: { approval: {} } } }])("rejects approval before projection without touching the source or network", async input => {
    const before = JSON.stringify(input), transport = vi.fn();
    await expect(importContainerCopy(input, "scene-document", transport)).rejects.toThrow("批准");
    expect(JSON.stringify(input)).toBe(before); expect(transport).not.toHaveBeenCalled();
  });

  it("copies a container without rewriting internal IDs or versions", async () => {
    const { container } = await migrateDocumentToContainer(source, { kind: "scene-document", projectId: "old-container", objectId: "document", versionId: "version", actor: "user", transactionId: "import" });
    const result = await importContainerCopy(container, "container", async (_url, init) => { const body = JSON.parse(String(init?.body)); return reply(body.project, body.projectId); });
    expect(result.container.id).not.toBe(container.id);
    expect(result.container.objects).toEqual(container.objects); expect(result.container.versions).toEqual(container.versions);
    expect(container.id).toBe("old-container");
  });

  it("rejects wrong identity and server conflicts, never attempting legacy sessions", async () => {
    const { container } = await migrateDocumentToContainer(source, { kind: "scene-document", projectId: "actual", objectId: "document", versionId: "version", actor: "user", transactionId: "import" });
    const transport = vi.fn(async () => reply(container, "actual"));
    await expect(readContainer("expected", undefined, transport)).rejects.toThrow("响应不完整");
    await expect(importContainerCopy(source, "scene-document", async () => Response.json({ error: "already exists" }, { status: 409 }))).rejects.toThrow("already exists");
    expect(transport).toHaveBeenCalledWith("/api/project-containers/snapshot?projectId=expected", { signal: undefined });
    expect(() => assertContainerImportable({ approval: null, frozen: false })).not.toThrow();
  });
});


const timeline = { schemaVersion: 1, id: "original-timeline", title: "Timeline", fps: 30, width: 1280, height: 720,
  tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "caption", kind: "text", text: "Subtitle", startMs: 0, durationMs: 1000 }] }] };

it("imports two explicit documents in one createOnly request without rewriting their IDs or sources", async () => {
  const before = JSON.stringify([source, timeline]);
  const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); expect(body.createOnly).toBe(true); return reply(body.project, body.projectId); });
  const result = await importContainerPair(source, timeline, transport);
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0]![0]).toBe("/api/project-containers/open");
  expect(result.container.objects.map(item => item.kind)).toEqual(["scene-document", "timeline-document"]);
  expect(result.container.versions.map(item => (item.payload as { id: string }).id)).toEqual([source.id, timeline.id]);
  expect(result.container.versions.map(item => item.archive!.original)).toEqual([source, timeline]);
  expect(JSON.stringify([source, timeline])).toBe(before);
});

it.each(["scene", "timeline"])("rejects approved or frozen %s input before any paired import request", async side => {
  for (const restriction of [{ frozen: true }, { metadata: { approval: { version: "approved" } } }]) {
    const first = side === "scene" ? { ...source, ...restriction } : source, second = side === "timeline" ? { ...timeline, ...restriction } : timeline;
    const before = JSON.stringify([first, second]), transport = vi.fn();
    await expect(importContainerPair(first, second, transport)).rejects.toThrow("批准");
    expect(transport).not.toHaveBeenCalled(); expect(JSON.stringify([first, second])).toBe(before);
  }
});

it("does not create a partial container when the second document is invalid", async () => {
  const transport = vi.fn(); await expect(importContainerPair(source, {}, transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});

it("retains the standalone timeline import path", async () => {
  const result = await importContainerCopy(timeline, "timeline-document", async (_url, init) => { const body = JSON.parse(String(init?.body)); return reply(body.project, body.projectId); });
  expect(result.container.objects).toHaveLength(1); expect(result.container.versions[0]!.payload).toMatchObject({ id: timeline.id });
});

it("does not dispatch a paired import aborted while document digests are being prepared", async () => {
  const controller = new AbortController(), transport = vi.fn();
  const pending = importContainerPair(source, timeline, transport, controller.signal); controller.abort();
  await expect(pending).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});

it("preserves media references without fetching or copying media bytes", async () => {
  const scene = { ...source, scenes: [{ ...source.scenes[0]!, narration: { ...source.scenes[0]!.narration, audioRef: "/api/media/assets/original.wav" } }] };
  const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return reply(body.project, body.projectId); });
  const result = await importContainerPair(scene, timeline, transport);
  expect(result.container.versions[0]!.payload).toMatchObject({ scenes: [{ narration: { audioRef: "/api/media/assets/original.wav" } }] });
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0]![0]).toBe("/api/project-containers/open");
});

const listRow = { projectId: "work-a", revision: 2, title: "作品", sceneCount: 1, timelineCount: 1, firstDocumentId: "doc-scene" };
it("reads bounded metadata and forwards cursor and abort without opening a project", async () => {
  const transport = vi.fn(async () => Response.json({ projects: [listRow], nextCursor: "work-a" }));
  const signal = new AbortController().signal;
  expect(await readContainerList("work-0", signal, transport)).toEqual({ projects: [listRow], nextCursor: "work-a" });
  expect(transport).toHaveBeenCalledWith("/api/project-containers/list?limit=20&cursor=work-0", { signal });
});
it.each([
  { projects: [listRow, listRow], nextCursor: null },
  { projects: [{ ...listRow, projectId: "../bad" }], nextCursor: null },
  { projects: [{ ...listRow, revision: -1 }], nextCursor: null },
  { projects: [{ ...listRow, title: "字".repeat(161) }], nextCursor: null },
  { projects: [{ ...listRow, sceneCount: 10001 }], nextCursor: null },
  { projects: [{ ...listRow, firstDocumentId: "bad/path" }], nextCursor: null },
  { projects: [{ ...listRow, payload: {} }], nextCursor: null },
  { projects: [], nextCursor: "work-a" },
  { projects: [listRow], nextCursor: "work-b" },
  { projects: Array.from({ length: 21 }, (_, i) => ({ ...listRow, projectId: `work-${i}` })), nextCursor: null },
])("rejects invalid list identities, pagination and non-metadata replies %#", async value => {
  await expect(readContainerList(undefined, undefined, async () => Response.json(value))).rejects.toThrow("响应无效");
});
it("rejects oversized bodies and pages behind the requested cursor", async () => {
  await expect(readContainerList(undefined, undefined, async () => new Response(" ".repeat(65537)))).rejects.toThrow("响应无效");
  await expect(readContainerList("work-a", undefined, async () => Response.json({ projects: [listRow], nextCursor: null }))).rejects.toThrow("响应无效");
  const transport = vi.fn(); await expect(readContainerList("../bad", undefined, transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});
