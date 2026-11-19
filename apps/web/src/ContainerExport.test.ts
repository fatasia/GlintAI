// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { registerAuthoringLeaveGuard } from "./authoring-leave";
import { ContainerExport } from "./ContainerExport";
import { downloadJson } from "./editor-model";
vi.mock("./editor-model", () => ({ downloadJson: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function observe(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await tick(); }); assertion(); });
}
async function reply() {
  const { container } = await migrateDocumentToContainer({ schemaVersion: 1, id: "source", title: "Saved", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "s", kind: "title", title: "Title", narration: { text: "Text", durationMs: 1000 } }] }, { kind: "scene-document", projectId: "work", objectId: "scene", versionId: "v1", actor: "user", transactionId: "import" });
  return { snapshot: { projectId: "work", document: container, revision: 3 }, look: { projectId: "work", revision: 3 } };
}
async function mount() {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ContainerExport, { projectId: "work" })); });
  return { host, render: async (projectId: string) => act(async () => { root.render(createElement(ContainerExport, { projectId })); }) };
}
async function click(host: HTMLElement) { await act(async () => { host.querySelector("button")!.click(); await tick(); }); }
it("exports the full verified saved snapshot only after explicit click", async () => {
  const value = await reply(), fetcher = vi.fn(async () => Response.json(value)); vi.stubGlobal("fetch", fetcher);
  const { host } = await mount(); expect(fetcher).not.toHaveBeenCalled(); expect(host.textContent).toContain("不含媒体文件");
  await click(host); await act(async () => { await vi.waitFor(() => expect(downloadJson).toHaveBeenCalledTimes(1)); });
  expect(downloadJson).toHaveBeenCalledWith("work-r3.glint.json", value.snapshot.document);
  expect(host.textContent).toContain("已导出完整作品 r3"); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("blocks unsaved work before reading and permits an explicit retry after saving", async () => {
  const value = await reply(), fetcher = vi.fn(async () => Response.json(value)); vi.stubGlobal("fetch", fetcher);
  const { host } = await mount(), release = registerAuthoringLeaveGuard("work", () => { throw new Error("保存尚未确认"); });
  try { await click(host); expect(host.textContent).toContain("保存尚未确认"); expect(fetcher).not.toHaveBeenCalled(); expect(downloadJson).not.toHaveBeenCalled(); }
  finally { release(); }
  await click(host); await act(async () => { await vi.waitFor(() => expect(downloadJson).toHaveBeenCalledTimes(1)); });
});
it("checks dirty guards again after an in-flight read and does not duplicate requests", async () => {
  const value = await reply(); let resolve!: (value: Response) => void, releaseDigest!: () => void;
  const digest = crypto.subtle.digest.bind(crypto.subtle), digestGate = new Promise<void>(done => { releaseDigest = done; });
  const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { await digestGate; return digest(...args); });
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
  const { host } = await mount(); await click(host); expect(host.querySelector("button")!.disabled).toBe(true); await click(host); expect(fetcher).toHaveBeenCalledTimes(1);
  const guard = vi.fn(() => { throw new Error("新的未保存草稿"); });
  const release = registerAuthoringLeaveGuard("work", guard);
  try {
    await act(async () => { resolve(Response.json(value)); await tick(); });
    expect(digestSpy).toHaveBeenCalledTimes(1); expect(guard).not.toHaveBeenCalled();
    // Releasing the async digest must not keep React inside the entire DOM wait.
    await act(async () => { releaseDigest(); });
    await observe(() => expect(host.textContent).toContain("新的未保存草稿"));
    expect(guard).toHaveBeenCalledTimes(1); expect(downloadJson).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(host.querySelector("button")!.disabled).toBe(false);
  } finally { releaseDigest(); release(); }
});
it.each(["unmount", "switch"])("ignores late reads after %s", async mode => {
  const value = await reply(); let resolve!: (value: Response) => void;
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
  const { host, render } = await mount(); await click(host); const signal = fetcher.mock.calls[0]![1]!.signal!;
  if (mode === "unmount") { dispose(); dispose = () => {}; } else await render("other");
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(Response.json(value)); await tick(); await tick(); }); expect(downloadJson).not.toHaveBeenCalled();
});
it.each(["digest", "identity", "http"])("does not download an invalid %s reply", async fault => {
  const value = await reply(); if (fault === "digest") value.snapshot.document.versions[0]!.contentDigest = "0".repeat(64);
  if (fault === "identity") value.snapshot.projectId = "other";
  vi.stubGlobal("fetch", async () => Response.json(value, { status: fault === "http" ? 503 : 200 }));
  const { host } = await mount(); await click(host); await observe(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(downloadJson).not.toHaveBeenCalled(); expect(host.querySelector("button")!.disabled).toBe(false);
});
