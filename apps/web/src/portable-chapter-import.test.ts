import { describe, expect, it, vi } from "vitest";
import { captureChapter, CHAPTERS_KEY, readChapters, writeChapters } from "./ChaptersStore";
import { parseEditorProject } from "./editor-model";
import { createPortableImportController } from "./portable-chapter-import";

const chapter = (id: string) => captureChapter(parseEditorProject({ schemaVersion: 1, id, title: id, aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "scene", kind: "title", title: "镜头", narration: { text: "旁白", durationMs: 1000 } },
] }), { mode: "source", text: "资料", template: "explainer", theme: "glint-dark", evidence: "依据" });
function setup() {
  const data = new Map<string, string>();
  let fail = false;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("quota"); data.set(key, value); } };
  const incoming = [chapter("new")];
  const adapter = { preflight: vi.fn(async (_serialized: string) => structuredClone(incoming)), publish: vi.fn(async (_serialized: string) => structuredClone(incoming)) };
  return { storage, incoming, adapter, controller: createPortableImportController(adapter, storage, async task => task()), failWrites: (value: boolean) => { fail = value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("portable import controller", () => {
  it("previews without writes or publication and requires the exact explicit confirmation", async () => {
    const { storage, adapter, controller, incoming } = setup();
    const preview = await controller.preflight("original package");
    expect(adapter.publish).not.toHaveBeenCalled(); expect(storage.getItem(CHAPTERS_KEY)).toBeNull();
    preview.chapters[0]!.title = "tampered preview";
    await expect(controller.confirm({})).rejects.toThrow(/确认/);
    expect(adapter.publish).not.toHaveBeenCalled();
    expect(await controller.confirm(preview.token)).toEqual(incoming);
    expect(adapter.publish).toHaveBeenCalledOnce(); expect(adapter.publish).toHaveBeenCalledWith("original package");
    expect(readChapters(storage)).toEqual(incoming); expect(controller.hasPending()).toBe(false);
    await expect(controller.confirm(preview.token)).rejects.toThrow(/预检/);
  });
  it("rejects invalid preflight, duplicate IDs, empty and oversized input without publishing", async () => {
    const { storage, adapter, controller, incoming } = setup();
    await expect(controller.preflight("")).rejects.toThrow(/为空/);
    await expect(controller.preflight("x".repeat(32 * 1024 * 1024 + 1))).rejects.toThrow(/32 MiB/);
    adapter.preflight.mockRejectedValueOnce(new Error("bad hash"));
    await expect(controller.preflight("invalid")).rejects.toThrow(/bad hash/);
    adapter.preflight.mockResolvedValueOnce([]);
    await expect(controller.preflight("empty")).rejects.toThrow(/没有/);
    writeChapters(incoming, storage);
    const preview = await controller.preflight("duplicate");
    expect(await controller.confirm(preview.token)).toEqual(incoming);
    expect(adapter.publish).toHaveBeenCalledOnce();
    adapter.preflight.mockResolvedValueOnce([{ ...incoming[0]!, title: "冲突" }]);
    await expect(controller.preflight("conflict")).rejects.toThrow(/冲突/);
  });
  it("retains the exact package when storage fails and republishes idempotently before retrying", async () => {
    const { storage, adapter, controller, failWrites } = setup();
    writeChapters([chapter("existing")], storage);
    const before = storage.getItem(CHAPTERS_KEY);
    const preview = await controller.preflight("original");
    failWrites(true);
    await expect(controller.confirm(preview.token)).rejects.toThrow(/原包.*保留/);
    expect(storage.getItem(CHAPTERS_KEY)).toBe(before); expect(controller.hasPending()).toBe(true);
    expect(controller.retainedPackage()).toBe("original");
    failWrites(false);
    expect((await controller.confirm(preview.token)).map(c => c.project.id)).toEqual(["existing", "new"]);
    expect(adapter.publish.mock.calls).toEqual([["original"], ["original"]]);
  });
  it("preserves the original package if a revalidation after storage failure fails", async () => {
    const { storage, adapter, controller, failWrites } = setup();
    const preview = await controller.preflight("original");
    failWrites(true);
    await expect(controller.confirm(preview.token)).rejects.toThrow(/保存失败/);
    failWrites(false);
    adapter.publish.mockRejectedValueOnce(new Error("素材名称冲突"));
    await expect(controller.confirm(preview.token)).rejects.toThrow(/冲突/);
    expect(storage.getItem(CHAPTERS_KEY)).toBeNull();
    expect(controller.retainedPackage()).toBe("original");
    expect(adapter.publish).toHaveBeenCalledTimes(2);
  });
  it("preserves package on failed or ambiguous publication and retries the same bytes", async () => {
    const { adapter, controller } = setup();
    const preview = await controller.preflight("original");
    adapter.publish.mockRejectedValueOnce(new Error("network lost"));
    await expect(controller.confirm(preview.token)).rejects.toThrow(/network lost/);
    expect(controller.hasPending()).toBe(true);
    await controller.confirm(preview.token);
    expect(adapter.publish.mock.calls).toEqual([["original"], ["original"]]);
  });
  it("refuses stale confirmation before publication and changes during publication before storing", async () => {
    const a = setup(), preview = await a.controller.preflight("a");
    writeChapters([chapter("other")], a.storage);
    await expect(a.controller.confirm(preview.token)).rejects.toThrow(/变化/);
    expect(a.adapter.publish).not.toHaveBeenCalled(); expect(a.controller.hasPending()).toBe(true);
    const b = setup(), gate = deferred<typeof b.incoming>();
    b.adapter.publish.mockReturnValueOnce(gate.promise);
    const p = await b.controller.preflight("b"), finishing = b.controller.confirm(p.token);
    writeChapters([chapter("other")], b.storage); gate.resolve(b.incoming);
    await expect(finishing).rejects.toThrow(/变化/);
    expect(readChapters(b.storage).map(c => c.project.id)).toEqual(["other"]);
  });
  it("blocks concurrent confirms and invalidates a cancelled in-flight preflight", async () => {
    const a = setup(), gate = deferred<typeof a.incoming>();
    a.adapter.preflight.mockReturnValueOnce(gate.promise);
    const waiting = a.controller.preflight("original");
    await expect(a.controller.preflight("second")).rejects.toThrow(/进行中/);
    a.controller.cancel(); gate.resolve(a.incoming);
    await expect(waiting).rejects.toThrow(/取消/); expect(a.controller.hasPending()).toBe(false);
    const b = setup(), pub = deferred<typeof b.incoming>();
    b.adapter.publish.mockReturnValueOnce(pub.promise);
    const preview = await b.controller.preflight("original"), finishing = b.controller.confirm(preview.token);
    await expect(b.controller.confirm(preview.token)).rejects.toThrow(/进行中/);
    expect(() => b.controller.cancel()).toThrow(/无法取消/);
    pub.resolve(b.incoming); await finishing; expect(b.adapter.publish).toHaveBeenCalledOnce();
  });
  it("blocks preflight if local state changes while the adapter is inspecting the package", async () => {
    const a = setup(), gate = deferred<typeof a.incoming>();
    a.adapter.preflight.mockReturnValueOnce(gate.promise);
    const waiting = a.controller.preflight("original");
    writeChapters([chapter("other")], a.storage); gate.resolve(a.incoming);
    await expect(waiting).rejects.toThrow(/变化/);
    expect(a.adapter.publish).not.toHaveBeenCalled(); expect(a.controller.hasPending()).toBe(false);
  });
  it("rejects lossy snapshots and unreadable local storage before publishing", async () => {
    const a = setup();
    const lossy = structuredClone(a.incoming) as typeof a.incoming & Array<{ extra?: string }>;
    lossy[0]!.extra = "must not disappear";
    a.adapter.preflight.mockResolvedValueOnce(lossy);
    await expect(a.controller.preflight("original")).rejects.toThrow(/完整保存/);
    a.storage.setItem(CHAPTERS_KEY, "bad json");
    await expect(a.controller.preflight("original")).rejects.toThrow();
    expect(a.adapter.publish).not.toHaveBeenCalled();
    expect(a.storage.getItem(CHAPTERS_KEY)).toBe("bad json");
  });
  it("does not publish if the cross-tab lock cannot be obtained", async () => {
    const { adapter, storage } = setup();
    const controller = createPortableImportController(adapter, storage, async () => { throw new Error("其他标签页正在修改章节"); });
    const preview = await controller.preflight("original package");
    await expect(controller.confirm(preview.token)).rejects.toThrow(/其他标签页/);
    expect(adapter.publish).not.toHaveBeenCalled();
    expect(storage.getItem(CHAPTERS_KEY)).toBeNull();
    expect(controller.retainedPackage()).toBe("original package");
  });
  it("rejects a publish result differing from the preview without storing it", async () => {
    const { adapter, controller, storage } = setup();
    const preview = await controller.preflight("original");
    adapter.publish.mockResolvedValueOnce([chapter("different")]);
    await expect(controller.confirm(preview.token)).rejects.toThrow(/不一致/);
    expect(storage.getItem(CHAPTERS_KEY)).toBeNull(); expect(controller.hasPending()).toBe(true);
  });
});
