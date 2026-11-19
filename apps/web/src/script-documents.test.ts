import { describe, expect, it } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { createProjectDocuments, createScriptDocument, previewScriptScenes, projectDocumentsKey, readProjectDocuments, saveProjectDocuments, scriptMarkdownExport, ScriptDocumentHistory, type DocumentStorage } from "./script-documents";

const project = SceneScriptProject.parse({ schemaVersion: 1, id: "text-project", title: "中文故事", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "opening", kind: "title", title: "开场", narration: { text: "雨落在窗前。", durationMs: 3000 } }] });
function storage(): DocumentStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
describe("project document sidecar", () => {
  it("reads the exact project key, seeds Chinese narration separately and never mutates project", () => {
    const store = storage(), before = JSON.stringify(project);
    expect(readProjectDocuments(project.id, store)).toEqual({ version: 1, projectId: project.id, documents: [], activeId: "" });
    const state = createProjectDocuments(project);
    expect(state.documents.map(doc => doc.kind)).toEqual(["script", "outline"]);
    expect(state.documents[0]!.content).toContain("## 镜头 1 · 开场\n\n雨落在窗前。");
    expect(JSON.stringify(project)).toBe(before);
    expect(store.getItem(projectDocumentsKey(project.id))).toBeNull();
    expect(projectDocumentsKey(project.id)).toBe("glint.project-documents.v1:text-project");
  });
  it("creates every supported plain-text kind, saves multiple exact bodies and restores active document", () => {
    const store = storage(), state = createProjectDocuments(project);
    const document = createScriptDocument("screenplay", "雨夜对白", "# 角色\r\n\t林：**你好**，世界！\r\n\r\n" + "长文本".repeat(200));
    state.documents.push(document, createScriptDocument("narration", "旁白")); state.activeId = document.id;
    saveProjectDocuments(state, store, null);
    expect(readProjectDocuments(project.id, store)).toEqual(state);
    expect(readProjectDocuments("other", store).documents).toEqual([]);
  });
  it.each(["{broken", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, projectId: "other", documents: [], activeId: "" })])("refuses damaged/wrong-project data without replacing raw bytes: %s", raw => {
    const store = storage(); store.setItem(projectDocumentsKey(project.id), raw);
    expect(() => readProjectDocuments(project.id, store)).toThrow();
    expect(() => saveProjectDocuments(createProjectDocuments(project), store)).toThrow();
    expect(store.getItem(projectDocumentsKey(project.id))).toBe(raw);
  });
  it("rejects invalid bodies, duplicate ids, inherited kinds and invalid active ids as a family", () => {
    for (const mutate of [
      (state: ReturnType<typeof createProjectDocuments>) => { state.documents[0]!.content = 1 as unknown as string; },
      (state: ReturnType<typeof createProjectDocuments>) => { state.documents[1]!.id = state.documents[0]!.id; },
      (state: ReturnType<typeof createProjectDocuments>) => { state.documents[0]!.kind = "toString" as "script"; },
      (state: ReturnType<typeof createProjectDocuments>) => { state.activeId = "missing"; },
    ]) {
      const store = storage(), state = createProjectDocuments(project); mutate(state);
      store.setItem(projectDocumentsKey(project.id), JSON.stringify(state));
      expect(() => readProjectDocuments(project.id, store)).toThrow();
      expect(() => saveProjectDocuments(state, store)).toThrow();
    }
  });
  it("fails closed on denied reads, quota and concurrent writes, allows a safe retry", () => {
    const store = storage(), state = createProjectDocuments(project); saveProjectDocuments(state, store, null);
    const before = store.getItem(projectDocumentsKey(project.id));
    const changed = { ...state, documents: [...state.documents, createScriptDocument("script")] };
    expect(() => saveProjectDocuments(changed, { ...store, setItem: () => { throw new Error("quota"); } }, before)).toThrow("草稿保留");
    expect(store.getItem(projectDocumentsKey(project.id))).toBe(before);
    expect(() => readProjectDocuments(project.id, { getItem: () => { throw new Error("denied"); } })).toThrow("读取失败");
    saveProjectDocuments(changed, store, before);
    expect(() => saveProjectDocuments(state, store, before)).toThrow("其他窗口");
    expect(readProjectDocuments(project.id, store)).toEqual(changed);
  });
  it("exports the real unsaved Markdown byte-for-byte and sanitizes only the filename", () => {
    const content = "# 中文\r\n\t**不格式化**\n\n<script>not executed</script>\n";
    expect(scriptMarkdownExport(createScriptDocument("outline", "大纲/草稿?", content))).toEqual({ filename: "大纲-草稿-.md", content });
  });
  it("previews heading sections without changing Markdown, dropping code or applying project edits", () => {
    const doc = createScriptDocument("screenplay", "对白", "# 剧本\n\n## 镜头 1\n\n雨夜。\n林：你好。\n\n## 场景 2\n\n她回头。\n");
    const before = JSON.stringify(doc);
    expect(previewScriptScenes(doc)).toEqual([{ title: "镜头 1", narration: "雨夜。\n林：你好。" }, { title: "场景 2", narration: "她回头。" }]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(previewScriptScenes(createScriptDocument("script"))).toEqual([]);
  });
  it("isolates bounded programmatic undo/redo per document and clears redo on a new edit", () => {
    const history = new ScriptDocumentHistory();
    expect(history.status("one")).toEqual({ canUndo: false, canRedo: false });
    history.record("one", "原稿", "原稿"); expect(history.status("one").canUndo).toBe(false);
    history.record("one", "原稿", "修改"); history.record("two", "另一稿", "新稿");
    expect(history.status("one")).toEqual({ canUndo: true, canRedo: false });
    expect(history.move("one", "修改", "undo")).toBe("原稿");
    expect(history.status("one")).toEqual({ canUndo: false, canRedo: true });
    expect(history.move("one", "原稿", "redo")).toBe("修改");
    history.record("one", "修改", "最终"); expect(history.move("one", "最终", "redo")).toBeUndefined();
    expect(history.move("two", "新稿", "undo")).toBe("另一稿");
    history.forget("one"); expect(history.move("one", "最终", "undo")).toBeUndefined();
  });
});
