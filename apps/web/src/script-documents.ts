import type { SceneScriptProject } from "@glintai/scenescript";
import { content as sectionContent, parseMarkdown } from "../../../packages/composer/src/parsing";

export type ScriptDocument = {
  id: string;
  title: string;
  kind: "script" | "screenplay" | "outline" | "narration";
  content: string;
  updatedAt: number;
};
export type ProjectDocuments = { version: 1; projectId: string; documents: ScriptDocument[]; activeId: string };
export type ScriptSelection = { documentId: string; text: string; start: number; end: number };
export type ScriptHistoryState = { canUndo: boolean; canRedo: boolean };
export type ScriptEditHandle = Readonly<ScriptHistoryState> & {
  /** 同步预检；父级在同一调用栈完成全部 JSON 写入后调用一次 accept，不得跨异步间隙。 */
  prepareRestore?(next: ProjectDocuments, expected: ProjectDocuments): () => void;
  /** 父级写入空文档 JSON 后执行，并在同一调用栈安排卸载；不渲染空 state。 */
  prepareDeactivate?(expected: ProjectDocuments): () => void;
  apply(before: ScriptDocument, next: ScriptDocument): boolean;
  undo(): void;
  redo(): void;
};
export type DocumentStorage = Pick<Storage, "getItem" | "setItem">;
export const documentKinds: Record<ScriptDocument["kind"], string> = { script: "脚本", screenplay: "剧本", outline: "大纲", narration: "旁白" };
export const projectDocumentsKey = (projectId: string) => `glint.project-documents.v1:${projectId}`;

function localStore(): Storage {
  try { if (globalThis.localStorage) return globalThis.localStorage; } catch { /* Access itself can be denied. */ }
  throw new Error("本机存储不可用；草稿仍在当前页面，请导出备份后重试。");
}
export function validateProjectDocuments(value: unknown, projectId: string): ProjectDocuments {
  const state = value as Partial<ProjectDocuments> | null;
  if (!state || state.version !== 1 || state.projectId !== projectId || !Array.isArray(state.documents) || typeof state.activeId !== "string") throw new Error("文档数据无法识别；旧存储未覆盖，请先备份旧数据。");
  const ids = new Set<string>();
  for (const doc of state.documents) {
    if (!doc || typeof doc.id !== "string" || !doc.id.trim() || ids.has(doc.id) || typeof doc.title !== "string" || !doc.title.trim() ||
      !Object.hasOwn(documentKinds, doc.kind) || typeof doc.content !== "string" || !Number.isFinite(doc.updatedAt) || doc.updatedAt < 0) throw new Error("文档数据损坏；旧存储未覆盖，请先备份旧数据。");
    ids.add(doc.id);
  }
  if (state.documents.length ? !ids.has(state.activeId) : state.activeId !== "") throw new Error("活动文档无效；旧存储未覆盖，请先备份旧数据。");
  return state as ProjectDocuments;
}

/** Missing storage has no project object to seed from; the editor calls createProjectDocuments. */
export function readProjectDocuments(projectId: string, storage?: Pick<Storage, "getItem">): ProjectDocuments {
  let raw: string | null;
  try { raw = (storage ?? localStore()).getItem(projectDocumentsKey(projectId)); }
  catch { throw new Error("本机文档读取失败；请保留页面并导出草稿，恢复存储权限后重试。"); }
  if (raw === null) return { version: 1, projectId, documents: [], activeId: "" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("本机文档损坏；旧存储未覆盖，请先备份旧数据。"); }
  return validateProjectDocuments(parsed, projectId);
}

/** Compare the last read bytes before writing; corrupt/conflicting data is never replaced. */
export function saveProjectDocuments(state: ProjectDocuments, storage?: DocumentStorage, expectedRaw?: string | null): ProjectDocuments {
  validateProjectDocuments(state, state.projectId);
  const store = storage ?? localStore();
  let raw: string | null;
  try { raw = store.getItem(projectDocumentsKey(state.projectId)); }
  catch { throw new Error("文档存储读取失败；草稿保留在页面，请导出或重试保存。"); }
  if (raw !== null) readProjectDocuments(state.projectId, { getItem: () => raw });
  if (expectedRaw !== undefined && raw !== expectedRaw) throw new Error("其他窗口已更新文档，未覆盖对方版本；请先导出当前草稿，再重新打开工程核对。");
  try { store.setItem(projectDocumentsKey(state.projectId), JSON.stringify(state)); }
  catch { throw new Error("保存失败（空间不足或权限受限）；草稿保留在页面，旧存储未覆盖。请导出或重试保存。"); }
  return state;
}

export function createScriptDocument(kind: ScriptDocument["kind"], title = `新${documentKinds[kind]}`, content = ""): ScriptDocument {
  return { id: crypto.randomUUID(), title, kind, content, updatedAt: Date.now() };
}
const sceneTitle = (scene: SceneScriptProject["scenes"][number]) => "title" in scene && scene.title ? scene.title : "heading" in scene && scene.heading ? scene.heading : scene.id;
export function createProjectDocuments(project: SceneScriptProject): ProjectDocuments {
  const script = createScriptDocument("script", `${project.title} · 脚本`, `# ${project.title}\n\n${project.scenes.map((scene, i) => `## 镜头 ${i + 1} · ${sceneTitle(scene)}\n\n${scene.narration.text}`).join("\n\n")}\n`);
  const outline = createScriptDocument("outline", `${project.title} · 大纲`, `# ${project.title} · 大纲\n\n${project.scenes.map((scene, i) => `- ${i + 1}. ${sceneTitle(scene)}`).join("\n")}\n`);
  return { version: 1, projectId: project.id, documents: [script, outline], activeId: script.id };
}

/** Exact Markdown body, not a render or a heading-prefixed reconstruction. */
export function scriptMarkdownExport(doc: ScriptDocument): { filename: string; content: string } {
  const title = doc.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[.\s]+$/, "").slice(0, 100) || "脚本文档";
  return { filename: `${title}.md`, content: doc.content };
}
export type ScriptScenePreview = { title: string; narration: string };
export function previewScriptScenes(doc: ScriptDocument): ScriptScenePreview[] {
  const parsed = parseMarkdown(doc.content);
  return parsed.sections.map(section => ({ title: section.heading || doc.title, narration: sectionContent(section).join("\n") })).filter(scene => scene.narration.trim());
}

type EditHistory<T> = { past: T[]; future: T[] };
/** 按文档隔离的有限历史，整份 AI 提案只记录一次。 */
export class ScriptDocumentHistory<T = string> {
  private entries = new Map<string, EditHistory<T>>();
  record(id: string, before: T, after: T) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const history = this.entries.get(id) ?? { past: [], future: [] };
    history.past = [...history.past.slice(-49), before]; history.future = [];
    this.entries.set(id, history);
  }
  status(id: string): ScriptHistoryState {
    const entry = this.entries.get(id);
    return { canUndo: Boolean(entry?.past.length), canRedo: Boolean(entry?.future.length) };
  }
  move(id: string, current: T, direction: "undo" | "redo"): T | undefined {
    const history = this.entries.get(id);
    if (!history) return;
    const source = direction === "undo" ? history.past : history.future;
    const target = direction === "undo" ? history.future : history.past;
    const next = source.pop();
    if (next !== undefined) target.push(current);
    return next;
  }
  forget(id: string) { this.entries.delete(id); }
}
