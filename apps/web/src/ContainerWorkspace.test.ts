// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import ContainerWorkspace from "./ContainerWorkspace";
import { useNleSharedDocument, type SharedNleBinding } from "./useNleSharedDocument";
import { assertAllAuthoringCanLeave, registerAuthoringLeaveGuard } from "./authoring-leave";
// Keep the real shared client/hook; the timeline canvas is outside this parent revision test.
vi.mock("./NleEditor", () => ({ NleEditor: ({ shared }: { shared: SharedNleBinding }) => useNleSharedDocument(shared, () => {}).panel }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const source = { schemaVersion: 1, id: "old-scene", title: "Original", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "Hello", durationMs: 1000 } }] };
const emptyList = () => Response.json({ projects: [], nextCursor: null });
function expectListOnly(network: ReturnType<typeof vi.fn>) {
  expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0]![0]).toBe("/api/project-containers/list?limit=20");
  expect(network.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(0);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function mount(projectId?: string) {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), onOpen = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => {
    root.render(createElement(ContainerWorkspace, { projectId, onOpen }));
    await tick();
  });
  await act(async () => {
    await Promise.all([import("./SceneEditor"), import("./ContainerGraph")]);
    await tick();
  });
  return { host, onOpen };
}
it("loads the real scene editor through container GET and retains its edited draft on CAS conflict", async () => {
  const { container } = await migrateDocumentToContainer(source, { kind: "scene-document", projectId: "work-test", objectId: "scene", versionId: "v1", actor: "user", transactionId: "import" });
  const reply = { snapshot: { projectId: container.id, document: container, revision: 0 }, look: { projectId: container.id, revision: 0, undoDepth: 0, redoDepth: 0, selection: [], digest: "digest" } };
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/project-containers/snapshot")) return Response.json(reply);
    if (String(url).endsWith("/project-containers/append")) return Response.json({ ...reply, receipt: { reason: "CAS conflict" } }, { status: 409 });
    return Response.json({});
  });
  vi.stubGlobal("fetch", network);
  const { host } = await mount(container.id);
  const title = host.querySelector<HTMLTextAreaElement>('[aria-label="title"]')!;
  expect(title).toBeTruthy(); expect(title.value).toBe("One");
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "Local draft"); title.dispatchEvent(new Event("input", { bubbles: true })); await tick(); });
  expect(title.value).toBe("Local draft"); expect(host.textContent).toContain("CAS conflict");
  expect(host.querySelector<HTMLFieldSetElement>("fieldset.workspace-editor")!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true);
  expect(() => assertAllAuthoringCanLeave()).toThrow("保存");
  const back = host.querySelector<HTMLAnchorElement>('a[href="#/c"]')!;
  expect(back.textContent).toBe("返回作品列表");
  const leaving = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { back.dispatchEvent(leaving); });
  expect(leaving.defaultPrevented).toBe(true); expect(title.value).toBe("Local draft");
  const append = network.mock.calls.find(([url]) => String(url).endsWith("/append"))!;
  const body = JSON.parse(String(append[1]?.body));
  expect(body.projectId).toBe("work-test"); expect(body.transaction.baseRevision).toBe(0);
  expect(body.changes[0]).toMatchObject({ objectId: "scene", payload: { id: "old-scene", scenes: [{ title: "Local draft" }] } });
  expect(network.mock.calls.some(([url]) => String(url).includes("/api/session/"))).toBe(false);
});
it("offers explicit new-copy import without opening any old session", async () => {
  const network = vi.fn(emptyList); vi.stubGlobal("fetch", network);
  const { host, onOpen } = await mount();
  expect(host.textContent).toContain("新副本");
  const importButton = [...host.querySelectorAll("button")].find(button => button.textContent === "导入为新副本")!;
  expect(importButton.disabled).toBe(true); expectListOnly(network); expect(onOpen).not.toHaveBeenCalled();
});

it("keeps real scene inputs enabled while saving and serializes the complete newer text", async () => {
  const options = { kind: "scene-document" as const, projectId: "work-typing", objectId: "scene", versionId: "v1", actor: "user", transactionId: "import" };
  let { container } = await migrateDocumentToContainer(source, options), revision = 0;
  const reply = () => ({ snapshot: { projectId: container.id, document: container, revision }, look: { projectId: container.id, revision, undoDepth: revision, redoDepth: 0, selection: [], digest: "fixture" } });
  let release!: () => void, releaseSecond!: () => void;
  const writes: Array<{ transaction: { id: string; baseRevision: number }; changes: Array<{ payload: typeof source; versionId: string }> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/append")) return Response.json(reply());
    const body = JSON.parse(String(init?.body)); writes.push(body);
    if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
    if (writes.length === 2) await new Promise<void>(resolve => { releaseSecond = resolve; });
    container = (await migrateDocumentToContainer(body.changes[0].payload, { ...options, versionId: body.changes[0].versionId })).container; revision++;
    return Response.json({ ...reply(), receipt: { transactionId: body.transaction.id, revision, stage: "verified" } });
  });
  const { host } = await mount(container.id);
  const title = host.querySelector<HTMLTextAreaElement>('[aria-label="title"]')!;
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
    title.dispatchEvent(new Event("input", { bubbles: true })); await tick();
  });
  await type("共");
  expect(host.querySelector<HTMLFieldSetElement>("fieldset.workspace-editor")!.disabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true);
  await type("共享分镜修改");
  expect(title.value).toBe("共享分镜修改"); expect(writes).toHaveLength(1);
  await act(async () => { release(); await tick(); });
  await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(2)); });
  expect(writes).toHaveLength(2);
  expect(writes.map(write => write.transaction.baseRevision)).toEqual([0, 1]);
  expect(writes[1]!.changes[0]!.payload.scenes[0]!.title).toBe("共享分镜修改");
  // A second request exists, but its digest/receipt/readback are not yet confirmed.
  expect(host.textContent).not.toContain("r2");
  expect(() => assertAllAuthoringCanLeave()).toThrow("保存");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true);
  await act(async () => { releaseSecond(); });
  await vi.waitFor(async () => {
    // Flush each observed React update rather than enclosing the entire wait in act.
    await act(async () => { await tick(); });
    expect(host.textContent).toContain("r2");
    expect(() => assertAllAuthoringCanLeave()).not.toThrow();
  });
  expect(title.value).toBe("共享分镜修改"); expect(host.textContent).toContain("r2");
  const back = host.querySelector<HTMLAnchorElement>('a[href="#/c"]')!;
  const leaving = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { back.dispatchEvent(leaving); });
  expect(leaving.defaultPrevented).toBe(false);
  expect(() => assertAllAuthoringCanLeave()).not.toThrow();
});



it("refreshes the container heading once when the shared timeline polls an external revision", async () => {
  const timeline = { schemaVersion: 1, id: "old-timeline", title: "Timeline", fps: 30, width: 1920, height: 1080,
    tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "clip", kind: "text", text: "Fixture", startMs: 0, durationMs: 1000 }] }] };
  const { container } = await migrateDocumentToContainer(timeline, { kind: "timeline-document", projectId: "work-timeline", objectId: "timeline", versionId: "v1", actor: "user", transactionId: "import" });
  let revision = 0;
  const network = vi.fn(async () => Response.json({ snapshot: { projectId: container.id, document: container, revision },
    look: { projectId: container.id, revision, undoDepth: revision, redoDepth: 0, selection: [], digest: `digest-${revision}` } }));
  vi.stubGlobal("fetch", network);
  let poll: (() => void) | undefined;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { host } = await mount(container.id);
  await act(async () => { await import("./NleEditor"); await tick(); });
  expect(host.textContent).toContain("共享版本 r0"); expect(host.textContent).toContain("共享时间线 · r0");
  const initial = network.mock.calls.length;
  revision = 2;
  await act(async () => { poll!(); await tick(); });
  await act(async () => { await tick(); });
  expect(host.textContent).toContain("共享版本 r2"); expect(host.textContent).toContain("共享时间线 · r2");
  expect(network.mock.calls.length - initial).toBe(2); // One timeline poll, one parent refresh.
  await act(async () => { poll!(); await tick(); });
  await act(async () => { await tick(); });
  expect(network.mock.calls.length - initial).toBe(3); // Unchanged status does not trigger a refresh loop.
});

const pairTimeline = { schemaVersion: 1, id: "pair-timeline", title: "Timeline", fps: 30, width: 1280, height: 720,
  tracks: [{ id: "text", kind: "text", name: "Text", clips: [{ id: "caption", kind: "text", text: "Subtitle", startMs: 0, durationMs: 1000 }] }] };
function importButton(host: HTMLElement) { return [...host.querySelectorAll("button")].find(button => button.textContent === "导入为新副本")!; }
async function choosePair(host: HTMLElement) {
  const select = host.querySelector<HTMLSelectElement>('fieldset select')!;
  await act(async () => { select.value = "paired"; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function chooseFile(host: HTMLElement, label: string, value?: unknown, options: { size?: number; text?: () => Promise<string> } = {}) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const file = new File([JSON.stringify(value)], "source.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: options.text ?? (async () => JSON.stringify(value)) });
  if (options.size !== undefined) Object.defineProperty(file, "size", { value: options.size });
  Object.defineProperty(input, "files", { value: value === undefined ? [] : [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function clickImport(host: HTMLElement) { await act(async () => { importButton(host).click(); await tick(); await tick(); }); }
async function confirmImport(host: HTMLElement) { await act(async () => { host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click(); }); }

it("requires both explicit sources and confirmation then opens one paired project", async () => {
  const network = vi.fn(async (_url: string, init?: RequestInit) => { if (_url.includes("/list?")) return emptyList(); const body = JSON.parse(String(init?.body)); return Response.json({ snapshot: { projectId: body.projectId, document: body.project, revision: 0 }, look: { projectId: body.projectId, revision: 0, undoDepth: 0, redoDepth: 0, selection: [], digest: "fixture" } }); });
  vi.stubGlobal("fetch", network); const { host, onOpen } = await mount(); await choosePair(host);
  expect(host.textContent).toContain("不复制磁盘上的媒体文件"); await chooseFile(host, "分镜文档 JSON", source); await confirmImport(host);
  expect(importButton(host).disabled).toBe(true); await chooseFile(host, "剪辑文档 JSON", pairTimeline);
  expect(importButton(host).disabled).toBe(true); await confirmImport(host); await clickImport(host);
  await act(async () => { await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1)); });
  expect(network).toHaveBeenCalledTimes(2);
  expect(network.mock.calls.filter(([url]) => url.includes("/list?"))).toHaveLength(1);
  const creates = network.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(creates).toHaveLength(1); expect(creates[0]![0]).toBe("/api/project-containers/open");
  const body = JSON.parse(String(creates[0]![1]?.body)); expect(body.createOnly).toBe(true); expect(body.project.objects).toHaveLength(2);
  expect(body.project.versions.map((version: { payload: { id: string } }) => version.payload.id)).toEqual([source.id, pairTimeline.id]);
  expect(onOpen).toHaveBeenCalledWith(body.projectId, undefined);
});

it("rejects either oversized paired source and clears consent when a file selection is cancelled", async () => {
  const network = vi.fn(emptyList); vi.stubGlobal("fetch", network); const { host } = await mount(); await choosePair(host);
  for (const largeSide of ["scene", "timeline"]) {
    await chooseFile(host, "分镜文档 JSON", source, largeSide === "scene" ? { size: 2 * 1024 * 1024 + 1 } : {});
    await chooseFile(host, "剪辑文档 JSON", pairTimeline, largeSide === "timeline" ? { size: 2 * 1024 * 1024 + 1 } : {});
    await confirmImport(host); await clickImport(host); expect(host.textContent).toContain("2 MiB"); expectListOnly(network);
  }
  await chooseFile(host, "剪辑文档 JSON"); expect(importButton(host).disabled).toBe(true); expect(host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.checked).toBe(false);
});

it("does not send an import when the second JSON is malformed", async () => {
  const network = vi.fn(emptyList); vi.stubGlobal("fetch", network); const { host } = await mount(); await choosePair(host);
  await chooseFile(host, "分镜文档 JSON", source); await chooseFile(host, "剪辑文档 JSON", pairTimeline, { text: async () => "{" });
  await confirmImport(host); await clickImport(host); expectListOnly(network); expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it("blocks leaving during paired reads and ignores a late read after unmount", async () => {
  let release!: (text: string) => void;
  const network = vi.fn(emptyList); vi.stubGlobal("fetch", network); const { host, onOpen } = await mount(); await choosePair(host);
  await chooseFile(host, "分镜文档 JSON", source); await chooseFile(host, "剪辑文档 JSON", pairTimeline, { text: () => new Promise(resolve => { release = resolve; }) });
  await confirmImport(host); await clickImport(host);
  expect(host.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true); expect(() => assertAllAuthoringCanLeave()).toThrow();
  dispose(); dispose = () => {}; await act(async () => { release(JSON.stringify(pairTimeline)); await tick(); });
  expectListOnly(network); expect(onOpen).not.toHaveBeenCalled(); expect(() => assertAllAuthoringCanLeave()).not.toThrow();
});

it("opens a listed object through the existing leave guard, without creating a project", async () => {
  const network = vi.fn(async () => Response.json({ projects: [{ projectId: "work-listed", title: "Listed", revision: 3, sceneCount: 1, timelineCount: 1, firstDocumentId: "scene-object" }], nextCursor: null }));
  vi.stubGlobal("fetch", network); const { host, onOpen } = await mount();
  const button = host.querySelector<HTMLButtonElement>('[aria-label="打开作品：Listed"]')!;
  const release = registerAuthoringLeaveGuard("retained", () => { throw new Error("Unsaved retained draft"); });
  try {
    await act(async () => { button.click(); });
    expect(onOpen).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unsaved retained draft");
  } finally { release(); }
  await act(async () => { button.click(); });
  expect(onOpen).toHaveBeenCalledTimes(1); expect(onOpen).toHaveBeenCalledWith("work-listed", "scene-object"); expectListOnly(network);
});
