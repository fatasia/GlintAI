// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { useNleSharedDocument } from "./useNleSharedDocument";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const documentValue = parseNleProject({ schemaVersion: 1, id: "timeline-old", title: "Timeline", fps: 30, width: 1920, height: 1080,
  tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "clip", kind: "text", text: "Fixture", startMs: 0, durationMs: 1000 }] }] });
const binding = { projectId: "container", objectId: "timeline" };
const result = (document = documentValue, revision = 0, transactionId?: string) => ({
  snapshot: { projectId: "container", revision, document: { format: "glint-project", version: 1, id: "container",
    objects: [{ id: "timeline", kind: "timeline-document", currentVersionId: "v1" }], versions: [{ id: "v1", objectId: "timeline", payload: document }] } },
  look: { projectId: "container", revision, undoDepth: revision, redoDepth: 0, selection: [], digest: "fixture" },
  ...(transactionId ? { receipt: { transactionId, stage: "verified", revision } } : {}),
});
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function mount() {
  let hook: ReturnType<typeof useNleSharedDocument>;
  const changed = vi.fn();
  function Harness() { hook = useNleSharedDocument(binding, changed); return hook.panel; }
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  const unmount = () => { act(() => root.unmount()); host.remove(); };
  cleanups.push(unmount);
  await act(async () => root.render(createElement(Harness))); await settle();
  return { get api() { return hook!; }, changed, host, unmount };
}
function server(fail = false) {
  let revision = 0, value = documentValue;
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    if (!body) return Response.json(result(value, revision));
    if (fail) return Response.json(result({ ...value, title: "Remote" }, revision + 1), { status: 409 });
    revision++;
    if (url.endsWith("append")) value = body.changes[0].payload;
    else value = documentValue;
    return Response.json(result(value, revision, body.transaction?.id ?? body.transactionId));
  });
  return calls;
}

it("initializes with GET, saves via the existing client and never writes local NLE records", async () => {
  const calls = server(); const write = vi.spyOn(Storage.prototype, "setItem");
  const h = await mount(); expect(h.api.ready).toBe(true);
  await act(async () => { expect(h.api.commit({ ...documentValue, title: "Edited" })).toBe(true); }); await settle();
  expect(calls.filter(c => c.body)).toHaveLength(1);
  expect(calls.find(c => c.body)?.body).toMatchObject({ projectId: "container", changes: [{ objectId: "timeline", payload: { id: "timeline-old", title: "Edited" } }] });
  expect(write).not.toHaveBeenCalled();
  expect(() => assertAuthoringCanLeave(["container"])).not.toThrow();
  expect(() => h.api.session.exportState()).toThrow();
});

it("keeps a gesture local until release, then sends one transaction and shares undo", async () => {
  const calls = server(), h = await mount();
  expect(h.api.beginGesture()).toBe(true);
  const moved = parseNleProject({ ...documentValue, tracks: [{ ...documentValue.tracks[0], clips: [{ ...documentValue.tracks[0]!.clips[0], startMs: 500 }] }] });
  expect(h.api.previewProject(moved)).toBe(true); expect(h.api.previewProject(moved)).toBe(true);
  expect(calls.filter(c => c.body)).toHaveLength(0);
  expect(() => assertAuthoringCanLeave(["container"])).toThrow();
  await act(async () => { expect(h.api.endGesture(moved)).toBe(true); }); await settle();
  expect(calls.filter(c => c.body)).toHaveLength(1);
  expect(h.api.session.undoDepth()).toBe(1);
  await act(async () => h.api.history("undo")); await settle();
  expect(calls.filter(c => c.body).at(-1)).toMatchObject({ url: "/api/project-containers/undo", body: { projectId: "container" } });
  expect(h.changed.mock.calls.at(-1)?.[0]).toEqual(documentValue);
});

it("retains conflicting draft and blocks leaving without local-history fallback", async () => {
  const calls = server(true), h = await mount();
  await act(async () => h.api.commit({ ...documentValue, title: "Unsaved" })); await settle();
  expect(h.changed.mock.calls.at(-1)?.[0].title).toBe("Unsaved");
  expect(() => assertAuthoringCanLeave(["container"])).toThrow();
  await act(async () => h.api.history("undo"));
  expect(calls.filter(c => c.body)).toHaveLength(1);
  expect(h.api.session.undoDepth()).toBe(0);
});

it("does not publish a late initialization after the editor is unmounted", async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { release = resolve; }));
  const h = await mount(); expect(h.api.ready).toBe(false);
  cleanups.pop(); h.unmount();
  await act(async () => release(Response.json(result()))); await settle();
  expect(h.changed).not.toHaveBeenCalled();
  expect(() => assertAuthoringCanLeave(["container"])).not.toThrow();
});

it("a no-op gesture creates no version and releases the leave guard", async () => {
  const calls = server(), h = await mount();
  expect(h.api.beginGesture()).toBe(true); expect(h.api.endGesture(documentValue)).toBe(true);
  expect(calls.filter(c => c.body)).toHaveLength(0);
  expect(() => assertAuthoringCanLeave(["container"])).not.toThrow();
});

it("retains newer timeline text during an in-flight save and sends it only after acknowledgement", async () => {
  let release!: () => void, revision = 0;
  const titles: string[] = [], bases: number[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (!init?.body) return Response.json(result());
    const body = JSON.parse(String(init.body)); titles.push(body.changes[0].payload.title); bases.push(body.transaction.baseRevision);
    if (titles.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return Response.json(result(body.changes[0].payload, ++revision, body.transaction.id));
  });
  const h = await mount();
  await act(async () => { expect(h.api.commit({ ...documentValue, title: "共" })).toBe(true); });
  expect(h.api.ready).toBe(true); expect(h.api.session.undoDepth()).toBe(0);
  await act(async () => { expect(h.api.commit({ ...documentValue, title: "共享剪辑修改" })).toBe(true); });
  expect(titles).toEqual(["共"]);
  expect(h.changed.mock.calls.at(-1)?.[0].title).toBe("共享剪辑修改");
  await act(async () => { release(); }); await settle();
  expect(titles).toEqual(["共", "共享剪辑修改"]); expect(bases).toEqual([0, 1]);
  expect(h.changed.mock.calls.at(-1)?.[0].title).toBe("共享剪辑修改");
  expect(() => assertAuthoringCanLeave(["container"])).not.toThrow();
});
