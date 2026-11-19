import type { AuthoringPersistence } from "./authoring-persistence";
import { useEffect, useRef, useState } from "react";
import { artifactFingerprint } from "./artifact-project";
import { createDesignDocument, createProjectDesignDocuments, DesignHistory, designDocumentsKey, readProjectDesignDocuments, saveProjectDesignDocuments, validateDesignDocuments, type DesignKind, type ProjectDesignDocuments } from "./design-artifacts";
import { pendingDesignDrafts as drafts, type DesignDraft as Draft } from "./authoring-drafts";
function load(projectId: string, title?: string, initialKind?: DesignKind, persistence?: AuthoringPersistence): Draft {
  const pending = drafts.get(projectId); if (pending) return pending;
  try {
    const state = readProjectDesignDocuments(projectId, persistence?.storage), raw = (persistence?.storage ?? localStorage).getItem(designDocumentsKey(projectId));
    if (!state.documents.length) return { state: createProjectDesignDocuments(projectId, title, initialKind), raw, error: "" };
    if (initialKind) {
      const found = state.documents.find(doc => doc.kind === initialKind);
      const next = found ?? createDesignDocument(initialKind, `${title || "设计工作稿"} · ${{ page: "页面", prototype: "原型", slides: "演示" }[initialKind]}`);
      return { state: { ...state, documents: found ? state.documents : [...state.documents, next], activeId: next.id }, raw, error: "" };
    }
    return { state, raw, error: "" };
  } catch (failure) { return { state: createProjectDesignDocuments(projectId, title, initialKind), raw: undefined, error: (failure as Error).message }; }
}
export function useDesignDocuments(projectId: string, title?: string, onChange?: (state: ProjectDesignDocuments) => void, externalState?: ProjectDesignDocuments, revision?: number, initialKind?: DesignKind, persistence?: AuthoringPersistence) {
  const [initial] = useState(() => load(projectId, title, initialKind, persistence));
  const [state, setState] = useState(initial.state), [error, setError] = useState(initial.error), [status, setStatus] = useState(initial.raw === JSON.stringify(initial.state) ? "已保存到本机" : "待保存");
  const current = useRef(state), baseline = useRef(initial.raw), composing = useRef(false), compositionBefore = useRef<ProjectDesignDocuments | null>(null);
  const history = useRef(new DesignHistory()), callback = useRef(onChange); callback.current = onChange;
  const source = useRef<HTMLTextAreaElement>(null);
  const savedFingerprint = useRef(initial.raw == null ? initial.raw : artifactFingerprint(JSON.parse(initial.raw)));
  const externalRevision = useRef(0), externalVersion = useRef<string | null>(null);
  const pendingExternal = useRef<{ state: ProjectDesignDocuments; legacy: boolean } | null>(null);
  const deactivated = useRef(false);
  const [restoreVersion, setRestoreVersion] = useState(0);
  function sourceMatches() {
    const doc = current.current.documents.find(item => item.id === current.current.activeId)!;
    return !source.current || source.current.value === doc.pages.find(item => item.id === doc.activePageId)!.html;
  }
  function assertSaved() {
    if (deactivated.current) return;
    if (composing.current) throw new Error("请先完成中文输入，再离开设计编辑器。");
    if (!sourceMatches()) throw new Error("设计源码与当前页面不同步；请完成输入并保存后重试。");
    if (savedFingerprint.current !== artifactFingerprint(current.current))
      throw new Error("设计文档仍有未保存修改；请先保存或导出后重试。");
  }
  function syncSource(next: ProjectDesignDocuments) {
    const doc = next.documents.find(item => item.id === next.activeId)!;
    if (source.current) { source.current.value = doc.pages.find(item => item.id === doc.activePageId)!.html; source.current.setSelectionRange(0, 0); }
  }
  function prepareDeactivate(expected: ProjectDesignDocuments) {
    prepareRestore(current.current, expected);
    const empty: ProjectDesignDocuments = { version: 1, projectId, documents: [], activeId: "" };
    const raw = JSON.stringify(empty), fingerprint = artifactFingerprint(empty), nextHistory = new DesignHistory();
    let accepted = false;
    return () => {
      if (accepted || deactivated.current) return;
      accepted = true; deactivated.current = true;
      baseline.current = raw; savedFingerprint.current = fingerprint;
      pendingExternal.current = null; compositionBefore.current = null;
      history.current = nextHistory; drafts.delete(projectId);
    };
  }
  function prepareRestore(next: ProjectDesignDocuments, expected: ProjectDesignDocuments) {
    if (deactivated.current) throw new Error("设计编辑器已停用，恢复未准备；请重新打开工程。");
    if (composing.current) throw new Error("请先完成中文输入，再恢复设计文档。");
    const valid = validateDesignDocuments(next, projectId);
    if (!valid.documents.length) throw new Error("恢复设计至少需要一个文档；空设计请由父级明确卸载编辑器。");
    if (artifactFingerprint(current.current) !== artifactFingerprint(expected)) throw new Error("设计文档已变化，恢复预期版本已过期；请重新核对。");
    if (!sourceMatches()) throw new Error("设计源码与当前页面不同步，恢复未准备；请完成输入后重试。");
    const raw = JSON.stringify(valid), snapshot = JSON.parse(raw) as ProjectDesignDocuments;
    const fingerprint = artifactFingerprint(snapshot), nextHistory = new DesignHistory();
    let accepted = false;
    return () => {
      if (accepted || deactivated.current) return;
      accepted = true;
      baseline.current = raw; savedFingerprint.current = fingerprint;
      pendingExternal.current = null; compositionBefore.current = null;
      history.current = nextHistory; drafts.delete(projectId);
      current.current = snapshot; setState(snapshot); syncSource(snapshot);
      setError(""); setStatus("已载入外部版本"); setRestoreVersion(value => value + 1);
    };
  }
  function replace(next: ProjectDesignDocuments, record = true) {
    if (deactivated.current || next === current.current) return;
    if (record && !composing.current) history.current.record(current.current, next);
    current.current = next; setState(next); setStatus("待保存");
    drafts.set(projectId, { state: next, raw: baseline.current, error });
  }
  function save() {
    if (deactivated.current || composing.current) return;
    try {
      if (baseline.current === undefined) throw new Error("旧设计文档未安全读取；请先导出当前草稿并备份旧数据，再重新打开工程。不会覆盖旧存储。");
      saveProjectDesignDocuments(current.current, persistence?.storage, baseline.current);
      baseline.current = JSON.stringify(current.current); savedFingerprint.current = artifactFingerprint(current.current);
      drafts.delete(projectId); setError(""); setStatus(persistence?.label ?? "已保存到本机");
    } catch (failure) {
      const message = (failure as Error).message; setError(message); setStatus("未保存 · 草稿仍在页面");
      drafts.set(projectId, { state: current.current, raw: baseline.current, error: message });
    }
  }
  function move(direction: "undo" | "redo") {
    if (persistence) { persistence.history[direction](); return; }
    if (composing.current) return;
    const next = history.current.move(current.current, direction); if (next) replace(next, false);
  }
  function composition(start: boolean) {
    if (start) { compositionBefore.current = current.current; composing.current = true; }
    else {
      composing.current = false;
      if (compositionBefore.current) history.current.record(compositionBefore.current, current.current);
      compositionBefore.current = null; setState({ ...current.current }); applyExternal();
    }
  }
  function applyExternal() {
    if (deactivated.current || composing.current || !pendingExternal.current) return;
    const { state: next, legacy } = pendingExternal.current; pendingExternal.current = null;
    try {
      const fingerprint = artifactFingerprint(next), unchanged = fingerprint === artifactFingerprint(current.current);
      // 无 revision 的旧调用允许替换尚未编辑的初始种子；显式恢复不享有此例外。
      const dirty = savedFingerprint.current !== artifactFingerprint(current.current) && (!legacy || history.current.canUndo);
      if (!unchanged && (dirty || !sourceMatches())) throw new Error("外部版本已更新，但本地有未保存修改；草稿已保留。请先导出或保存，再重新应用外部版本。");
      const raw = (persistence?.storage ?? localStorage).getItem(designDocumentsKey(projectId));
      const disk = readProjectDesignDocuments(projectId, { getItem: () => raw });
      const diskFingerprint = raw === null ? null : artifactFingerprint(disk);
      if (unchanged && diskFingerprint !== artifactFingerprint(current.current)) return;
      baseline.current = raw; savedFingerprint.current = diskFingerprint;
      if (!unchanged) {
        history.current = new DesignHistory(); current.current = next; setState(next); syncSource(next);
        setRestoreVersion(value => value + 1);
      }
      if (diskFingerprint === fingerprint) drafts.delete(projectId);
      else drafts.set(projectId, { state: next, raw, error: "" });
      setError(""); setStatus(diskFingerprint === fingerprint ? "已载入外部版本" : "外部版本待保存");
    } catch (failure) { setError((failure as Error).message); }
  }
  useEffect(() => {
    if (deactivated.current || !externalState) return;
    if (revision !== undefined) {
      if (!revision || !Number.isFinite(revision) || revision <= externalRevision.current) return;
      externalRevision.current = revision;
    } else {
      const signature = artifactFingerprint(externalState);
      if (externalVersion.current === signature) return;
      externalVersion.current = signature;
    }
    pendingExternal.current = null;
    try {
      const valid = validateDesignDocuments(externalState, projectId);
      if (!valid.documents.length) throw new Error("外部设计文档为空；当前草稿保留，请先创建一个页面再应用。");
      pendingExternal.current = { state: JSON.parse(JSON.stringify(valid)) as ProjectDesignDocuments, legacy: revision === undefined };
      applyExternal();
    } catch (failure) { setError((failure as Error).message); }
  }, [externalState, revision, projectId]);
  useEffect(() => { callback.current?.(state); }, [state]);
  useEffect(() => {
    if (savedFingerprint.current === artifactFingerprint(state) || baseline.current === undefined) return;
    const timer = setTimeout(() => {
      if (savedFingerprint.current !== artifactFingerprint(current.current)) save();
    }, 650);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (!deactivated.current && savedFingerprint.current !== artifactFingerprint(current.current)) { event.preventDefault(); event.returnValue = ""; } };
    const storage = (event: StorageEvent) => { if (event.key === designDocumentsKey(projectId) || event.key === null) setError("其他窗口可能已更新设计文档；草稿保留，保存时会核对版本。请先导出再核对。"); };
    window.addEventListener("beforeunload", unload); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("beforeunload", unload); window.removeEventListener("storage", storage); };
  }, [projectId]);
  return { state, current, replace, save, move, composition, composing, source, assertSaved, prepareRestore, prepareDeactivate, restoreVersion, history: persistence?.history ?? history.current, historyRef: history, error, setError, status };
}
