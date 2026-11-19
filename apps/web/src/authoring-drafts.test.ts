import { afterEach, expect, it, vi } from "vitest";
import { pendingScriptDrafts, pendingDesignDrafts, readPendingScriptDocuments, readPendingDesignDocuments, clearPendingAuthoringDrafts, type ScriptDraft, type DesignDraft } from "./authoring-drafts";

const script = (projectId: string): ScriptDraft => ({ state: { version: 1, projectId, activeId: "script", documents: [{ id: "script", title: "草稿", kind: "script", content: "未保存脚本", updatedAt: 1 }] }, raw: null, error: "" });
const design = (projectId: string): DesignDraft => ({ state: { version: 1, projectId, activeId: "design", documents: [{ id: "design", title: "草稿", kind: "page", activePageId: "page", updatedAt: 1, pages: [{ id: "page", title: "首页", html: "<p>未保存设计</p>", annotations: [{ id: "mark", x: 1, y: 2, text: "批注", createdAt: 1 }] }] }] }, raw: undefined, error: "读取失败" });
afterEach(() => { pendingScriptDrafts.clear(); pendingDesignDrafts.clear(); vi.unstubAllGlobals(); });

it("无缓存返回 undefined，读取不访问存储", () => {
  const getItem = vi.fn(() => { throw new Error("不应访问磁盘"); }); vi.stubGlobal("localStorage", { getItem });
  expect(readPendingScriptDocuments("missing")).toBeUndefined(); expect(readPendingDesignDocuments("missing")).toBeUndefined();
  pendingScriptDrafts.set("a", script("a")); pendingDesignDrafts.set("a", design("a"));
  expect(readPendingScriptDocuments("a")!.documents[0]!.content).toBe("未保存脚本");
  expect(readPendingDesignDocuments("a")!.documents[0]!.pages[0]!.annotations![0]!.text).toBe("批注");
  expect(getItem).not.toHaveBeenCalled();
});

it("读取返回完整深拷贝，修改返回值不会污染后续备份与编辑器草稿", () => {
  const a = script("a"), b = design("a"); pendingScriptDrafts.set("a", a); pendingDesignDrafts.set("a", b);
  const first = readPendingScriptDocuments("a")!, second = readPendingDesignDocuments("a")!;
  expect(first).toEqual(a.state); expect(first).not.toBe(a.state); expect(second).toEqual(b.state);
  first.documents[0]!.content = "外部修改"; first.documents.push({ ...first.documents[0]!, id: "extra" });
  second.documents[0]!.pages[0]!.annotations![0]!.text = "外部修改"; second.documents[0]!.pages.push({ id: "extra", title: "新页", html: "" });
  expect(readPendingScriptDocuments("a")).toEqual(a.state); expect(readPendingDesignDocuments("a")).toEqual(b.state);
  expect(a.state.documents).toHaveLength(1); expect(b.state.documents[0]!.pages).toHaveLength(1);
  expect(pendingScriptDrafts.get("a")).toBe(a); expect(pendingDesignDrafts.get("a")).toBe(b);
});

it("清理仅影响指定项目与指定模块，空选项和 false 均不清理", () => {
  for (const id of ["a", "b"]) { pendingScriptDrafts.set(id, script(id)); pendingDesignDrafts.set(id, design(id)); }
  clearPendingAuthoringDrafts("a", {}); clearPendingAuthoringDrafts("a", { script: false, design: false });
  expect(pendingScriptDrafts.size).toBe(2); expect(pendingDesignDrafts.size).toBe(2);
  clearPendingAuthoringDrafts("a", { script: true });
  expect(readPendingScriptDocuments("a")).toBeUndefined(); expect(readPendingDesignDocuments("a")).toBeDefined();
  expect(readPendingScriptDocuments("b")).toBeDefined(); expect(readPendingDesignDocuments("b")).toBeDefined();
  pendingScriptDrafts.set("a", script("a")); clearPendingAuthoringDrafts("a", { design: true });
  expect(readPendingScriptDocuments("a")).toBeDefined(); expect(readPendingDesignDocuments("a")).toBeUndefined();
  clearPendingAuthoringDrafts("b", { script: true, design: true }); clearPendingAuthoringDrafts("missing", { script: true, design: true });
  expect(readPendingScriptDocuments("b")).toBeUndefined(); expect(readPendingDesignDocuments("b")).toBeUndefined();
});

it("显式空 state 仍是缓存而不是缺失，不因读取而清理错误与原始基线", () => {
  pendingScriptDrafts.set("a", { state: { version: 1, projectId: "a", documents: [], activeId: "" }, raw: "旧 bytes", error: "quota" });
  pendingDesignDrafts.set("a", { state: { version: 1, projectId: "a", documents: [], activeId: "" }, raw: undefined, error: "denied" });
  expect(readPendingScriptDocuments("a")!.documents).toEqual([]); expect(readPendingDesignDocuments("a")!.documents).toEqual([]);
  expect(pendingScriptDrafts.get("a")).toMatchObject({ raw: "旧 bytes", error: "quota" });
  expect(pendingDesignDrafts.get("a")).toMatchObject({ raw: undefined, error: "denied" });
});
