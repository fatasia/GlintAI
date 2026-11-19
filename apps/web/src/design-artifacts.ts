export type DesignKind = "page" | "prototype" | "slides";
export type DesignAnnotation = { id: string; x: number; y: number; text: string; nodeId?: string; createdAt: number };
export type DesignPageTransition = { type: "none" | "fade" | "push" | "wipe" | "zoom"; durationMs: number };
export type DesignPage = { id: string; title: string; html: string; notes?: string; annotations?: DesignAnnotation[]; transition?: DesignPageTransition; stepReveal?: boolean };
export type DesignDocument = { id: string; title: string; kind: DesignKind; pages: DesignPage[]; activePageId: string; updatedAt: number };
export type ProjectDesignDocuments = { version: 1; projectId: string; documents: DesignDocument[]; activeId: string };
export type DesignSelection = { documentId: string; pageId: string; nodeId: string; nodeIds?: string[]; text: string; tagName?: string; editable?: boolean };
export type DesignExportContext = { state: ProjectDesignDocuments; document: DesignDocument; page: DesignPage };
export type DesignStorage = Pick<Storage, "getItem" | "setItem">;
// Value import stays cycle-free: design-transition.ts only imports types from here.
import { isValidDesignTransition } from "./design-transition";
export const designKinds: Record<DesignKind, string> = { page: "页面", prototype: "原型", slides: "幻灯片" };
export const designDocumentsKey = (projectId: string) => `glint.project-designs.v1:${projectId}`;
export const projectDesignDocumentsKey = designDocumentsKey;
export const DESIGN_HTML_LIMIT = 1024 * 1024;
export const DESIGN_PAGE_LIMIT = 100;
export const DESIGN_ANNOTATION_LIMIT = 200;
export const designId = () => crypto.randomUUID();

function store(): Storage {
  try { if (globalThis.localStorage) return globalThis.localStorage; } catch { /* Report denied access below. */ }
  throw new Error("本机存储不可用；请保留页面，导出草稿后恢复存储权限。");
}
export function validateDesignDocuments(value: unknown, projectId: string): ProjectDesignDocuments {
  const state = value as ProjectDesignDocuments | null;
  const invalid = () => new Error("设计文档数据无法识别；旧存储未覆盖，请先备份旧数据。");
  if (!state || state.version !== 1 || state.projectId !== projectId || !Array.isArray(state.documents) || typeof state.activeId !== "string") throw invalid();
  const ids = new Set<string>();
  for (const doc of state.documents) {
    if (!doc || typeof doc.id !== "string" || !doc.id || ids.has(doc.id) || typeof doc.title !== "string" || !doc.title.trim() ||
      !Object.hasOwn(designKinds, doc.kind) || !Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > DESIGN_PAGE_LIMIT ||
      !Number.isFinite(doc.updatedAt) || doc.updatedAt < 0) throw invalid();
    ids.add(doc.id); const pages = new Set<string>();
    for (const page of doc.pages) {
      if (!page || typeof page.id !== "string" || !page.id || pages.has(page.id) || typeof page.title !== "string" || !page.title.trim() ||
        typeof page.html !== "string" || page.html.length > DESIGN_HTML_LIMIT || (page.notes !== undefined && typeof page.notes !== "string")) throw invalid();
      if (page.transition !== undefined && !isValidDesignTransition(page.transition)) throw invalid();
      if (page.stepReveal !== undefined && typeof page.stepReveal !== "boolean") throw invalid();
      if (page.annotations !== undefined) {
        if (!Array.isArray(page.annotations) || page.annotations.length > DESIGN_ANNOTATION_LIMIT) throw invalid();
        const marks = new Set<string>();
        for (const mark of page.annotations) {
          if (!mark || typeof mark.id !== "string" || !mark.id || marks.has(mark.id) ||
            !Number.isFinite(mark.x) || mark.x < 0 || mark.x > 100 || !Number.isFinite(mark.y) || mark.y < 0 || mark.y > 100 ||
            typeof mark.text !== "string" || mark.text.length > 2000 || !Number.isFinite(mark.createdAt) || mark.createdAt < 0 ||
            (mark.nodeId !== undefined && (typeof mark.nodeId !== "string" || !/^[\w-]{1,100}$/.test(mark.nodeId)))) throw invalid();
          marks.add(mark.id);
        }
      }
      pages.add(page.id);
    }
    if (!pages.has(doc.activePageId)) throw invalid();
  }
  if (state.documents.length ? !ids.has(state.activeId) : state.activeId !== "") throw invalid();
  return state;
}
export function readProjectDesignDocuments(projectId: string, storage?: Pick<Storage, "getItem">): ProjectDesignDocuments {
  let raw: string | null;
  try { raw = (storage ?? store()).getItem(designDocumentsKey(projectId)); }
  catch { throw new Error("设计文档读取失败；旧存储未覆盖，请恢复权限后重试。"); }
  if (raw === null) return { version: 1, projectId, documents: [], activeId: "" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("设计文档损坏；旧存储未覆盖，请先备份旧数据。"); }
  return validateDesignDocuments(parsed, projectId);
}
/** Byte comparison protects corrupt/foreign data and concurrent tabs; failure never clears storage. */
export function saveProjectDesignDocuments(state: ProjectDesignDocuments, storage?: DesignStorage, expectedRaw?: string | null): ProjectDesignDocuments {
  validateDesignDocuments(state, state.projectId);
  const target = storage ?? store(); let raw: string | null;
  try { raw = target.getItem(designDocumentsKey(state.projectId)); }
  catch { throw new Error("保存前读取失败；当前草稿保留，请导出或恢复存储权限后重试。"); }
  if (raw !== null) readProjectDesignDocuments(state.projectId, { getItem: () => raw });
  if (expectedRaw !== undefined && raw !== expectedRaw) throw new Error("其他窗口已更新设计文档；未覆盖对方版本，请先导出当前草稿再重新打开核对。");
  try { target.setItem(designDocumentsKey(state.projectId), JSON.stringify(state)); }
  catch { throw new Error("保存失败（空间不足或权限受限）；旧存储未覆盖，草稿仍在页面，请导出或重试。"); }
  return state;
}
export function updateDesignDocument(state: ProjectDesignDocuments, next: DesignDocument): ProjectDesignDocuments {
  return { ...state, documents: state.documents.map(doc => doc.id === next.id ? { ...next, updatedAt: Date.now() } : doc) };
}
export function reorderDesignPages(doc: DesignDocument, from: number, to: number): DesignDocument {
  if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < doc.pages.length)) throw new Error("页面排序位置无效。");
  if (from === to) return doc;
  const pages = [...doc.pages], [page] = pages.splice(from, 1); pages.splice(to, 0, page!);
  return { ...doc, pages, updatedAt: Date.now() };
}
export class DesignHistory {
  private past: ProjectDesignDocuments[] = [];
  private future: ProjectDesignDocuments[] = [];
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  record(before: ProjectDesignDocuments, after: ProjectDesignDocuments) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.past = [...this.past.slice(-39), before]; this.future = [];
  }
  move(current: ProjectDesignDocuments, direction: "undo" | "redo"): ProjectDesignDocuments | undefined {
    const source = direction === "undo" ? this.past : this.future, target = direction === "undo" ? this.future : this.past;
    const next = source.pop(); if (next) target.push(current); return next;
  }
}
export { createDesignDocument, createProjectDesignDocuments } from "./design-editor-seeds";
