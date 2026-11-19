import { loadScriptDraft } from "./script-editor-load";
import type { AuthoringPersistence } from "./authoring-persistence";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { createScriptDocument, documentKinds, previewScriptScenes, projectDocumentsKey, readProjectDocuments, saveProjectDocuments, scriptMarkdownExport, validateProjectDocuments, ScriptDocumentHistory, type ProjectDocuments, type ScriptDocument, type ScriptSelection } from "./script-documents";
import { artifactFingerprint, validateArtifactProposal } from "./artifact-project";
import type { ScriptEditHandle, ScriptHistoryState } from "./script-documents";
import { pendingScriptDrafts as pendingDrafts } from "./authoring-drafts";
import { useAuthoringLeaveGuard } from "./authoring-leave";
import "./script-editor.css";

export interface ScriptEditorProps {
  project: SceneScriptProject;
  persistence?: AuthoringPersistence;
  active?: boolean;
  initialDocuments?: ProjectDocuments;
  externalState?: ProjectDocuments;
  revision?: number;
  editHandle?: { current: ScriptEditHandle | null };
  onHistoryChange?: (state: ScriptHistoryState) => void;
  selectedDocumentId?: string;
  selectionRequest?: number;
  onSelection?: (ctx: ScriptSelection) => void;
  onDocumentsChange?: (state: ProjectDocuments) => void;
  onBuildScenes?: (document: ScriptDocument) => void;
  onChangeProject?: (next: SceneScriptProject) => void;
}
const SAVE_DELAY_MS = 600;
/** 项目切换时隔离选择、确认状态与脚本文档历史。 */
export function ScriptEditor(props: ScriptEditorProps) { return <DocumentEditor key={props.project.id} {...props} />; }
export default ScriptEditor;

function DocumentEditor({ project, persistence, active = true, initialDocuments, externalState, revision, editHandle, onHistoryChange, selectionRequest, selectedDocumentId, onSelection, onDocumentsChange, onBuildScenes }: ScriptEditorProps) {
  const [initial] = useState(() => {
    const loaded = loadScriptDraft(project, persistence?.storage);
    return initialDocuments && !pendingDrafts.has(project.id) && loaded.raw === null ? { ...loaded, state: initialDocuments } : loaded;
  });
  const [state, setState] = useState(initial.state);
  const [error, setError] = useState(initial.error);
  const [status, setStatus] = useState(initial.raw === JSON.stringify(initial.state) ? "已保存到本机" : "待保存");
  const [panel, setPanel] = useState<"new" | "rename" | "delete" | "preview" | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ScriptDocument["kind"]>("outline");
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState("");
  const [restoreVersion, setRestoreVersion] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const formComposition = useRef<HTMLElement | null>(null);
  const baseline = useRef(initial.raw);
  const savedFingerprint = useRef(initial.raw == null ? initial.raw : artifactFingerprint(JSON.parse(initial.raw)));
  const externalRevision = useRef(0);
  const pendingExternal = useRef<ProjectDocuments | null>(null);
  const deactivated = useRef(false);
  const current = useRef(state);
  const composing = useRef(false);
  const compositionBefore = useRef<ScriptDocument | null>(null);
  const history = useRef(new ScriptDocumentHistory<ScriptDocument>());
  const mounted = useRef(false);
  const activeRef = useRef(active); activeRef.current = active;
  const historyCallback = useRef(onHistoryChange); historyCallback.current = onHistoryChange;
  const callback = useRef(onDocumentsChange); callback.current = onDocumentsChange;
  const selectionCallback = useRef(onSelection); selectionCallback.current = onSelection;
  const doc = state.documents.find(item => item.id === state.activeId)!;
  const dirty = savedFingerprint.current !== artifactFingerprint(state);
  useAuthoringLeaveGuard(project.id, () => {
    if (deactivated.current) return;
    if (composing.current || formComposition.current?.isConnected)
      throw new Error("请先完成中文输入，再离开脚本编辑器。");
    const currentDoc = current.current.documents.find(item => item.id === current.current.activeId)!;
    if (!area.current || area.current.value !== currentDoc.content)
      throw new Error("脚本正文与当前文档不同步；请完成输入并保存后重试。");
    if ((panel === "new" && (titleInput.current?.value || kind !== "outline")) ||
      (panel === "rename" && titleInput.current?.value !== currentDoc.title))
      throw new Error("脚本文档名称尚未提交；请先确定或取消，再离开编辑器。");
    if (savedFingerprint.current !== artifactFingerprint(current.current))
      throw new Error("脚本文档仍有未保存修改；请先保存或导出后重试。");
  });
  function replace(next: ProjectDocuments) {
    if (deactivated.current) return;
    current.current = next; setState(next); setConsent(false); setPanel(null); setNotice(""); setStatus("待保存");
    pendingDrafts.set(project.id, { state: next, raw: baseline.current, error: "" });
  }
  function save() {
    if (deactivated.current || composing.current) return;
    const next = current.current;
    try {
      // A failed initial read never grants permission to overwrite a now-readable value.
      if (baseline.current === undefined) throw new Error("旧文档尚未安全读取；请导出当前草稿后重新打开工程，旧存储不会覆盖。");
      saveProjectDocuments(next, persistence?.storage, baseline.current);
      baseline.current = JSON.stringify(next); savedFingerprint.current = artifactFingerprint(next);
      pendingDrafts.delete(project.id); setError(""); setStatus(persistence?.label ?? "已保存到本机");
    } catch (failure) {
      const message = (failure as Error).message;
      pendingDrafts.set(project.id, { state: next, raw: baseline.current, error: message }); setError(message); setStatus("未保存 · 草稿仍在页面");
    }
  }
  useEffect(() => {
    mounted.current = true;
    let live = true;
    const handle: ScriptEditHandle = {
      prepareDeactivate(expected) {
        handle.prepareRestore!(current.current, expected);
        const empty: ProjectDocuments = { version: 1, projectId: project.id, documents: [], activeId: "" };
        const raw = JSON.stringify(empty), fingerprint = artifactFingerprint(empty), nextHistory = new ScriptDocumentHistory<ScriptDocument>();
        let accepted = false;
        return () => {
          if (accepted || !live || !mounted.current || deactivated.current) return;
          accepted = true; deactivated.current = true;
          baseline.current = raw; savedFingerprint.current = fingerprint;
          pendingExternal.current = null; compositionBefore.current = null;
          history.current = nextHistory; pendingDrafts.delete(project.id);
        };
      },
      prepareRestore(next, expected) {
        if (deactivated.current) throw new Error("脚本编辑器已停用，恢复未准备；请重新打开工程。");
        if (!live || !mounted.current) throw new Error("脚本编辑器已卸载，恢复未准备；请重新打开工程。");
        if (composing.current) throw new Error("请先完成中文输入，再恢复脚本文档。");
        const valid = validateProjectDocuments(next, project.id);
        if (!valid.documents.length) throw new Error("恢复脚本文档至少需要一个文档。");
        if (artifactFingerprint(current.current) !== artifactFingerprint(expected)) throw new Error("脚本文档已变化，恢复预期版本已过期；请重新核对。");
        const existing = current.current.documents.find(item => item.id === current.current.activeId)!;
        if (!area.current || area.current.value !== existing.content) throw new Error("脚本正文与当前文档不同步，恢复未准备；请完成输入后重试。");
        const raw = JSON.stringify(valid), snapshot = JSON.parse(raw) as ProjectDocuments;
        const fingerprint = artifactFingerprint(snapshot), nextHistory = new ScriptDocumentHistory<ScriptDocument>();
        const content = snapshot.documents.find(item => item.id === snapshot.activeId)!.content;
        let accepted = false;
        return () => {
          if (accepted || !live || !mounted.current || deactivated.current) return;
          accepted = true;
          baseline.current = raw; savedFingerprint.current = fingerprint;
          pendingExternal.current = null; compositionBefore.current = null;
          history.current = nextHistory; pendingDrafts.delete(project.id);
          current.current = snapshot; setState(snapshot);
          setConsent(false); setPanel(null); setNotice(""); setError(""); setStatus("已载入外部版本");
          if (area.current) { area.current.value = content; area.current.setSelectionRange(0, 0); }
          setRestoreVersion(value => value + 1);
        };
      },
      get canUndo() { return history.current.status(current.current.activeId).canUndo; },
      get canRedo() { return history.current.status(current.current.activeId).canRedo; },
      apply(before, next) {
        if (!live || !mounted.current || composing.current) return false;
        const existing = current.current.documents.find(item => item.id === before.id);
        if (!existing || before.id !== next.id || before.kind !== next.kind || artifactFingerprint(existing) !== artifactFingerprint(before)) return false;
        if (existing.id === current.current.activeId && area.current?.value !== existing.content) return false;
        const base = { schemaVersion: 1 as const, id: project.id, title: project.title, document: before };
        try { validateArtifactProposal(base, { ...base, document: next }); } catch { return false; }
        history.current.record(before.id, { ...existing }, { ...next });
        replace({ ...current.current, documents: current.current.documents.map(item => item.id === next.id ? { ...next } : item) });
        if (current.current.activeId === next.id && area.current) area.current.value = next.content;
        return true;
      },
      undo: () => { if (live && mounted.current) move("undo"); },
      redo: () => { if (live && mounted.current) move("redo"); },
    };
    if (editHandle) editHandle.current = handle;
    return () => { live = false; mounted.current = false; if (editHandle?.current === handle) editHandle.current = null; };
  }, [editHandle, project.id, project.title]);
  useEffect(() => { callback.current?.(state); historyCallback.current?.(history.current.status(state.activeId)); }, [state]);
  useEffect(() => {
    if (restoreVersion) selectionCallback.current?.({ documentId: current.current.activeId, text: "", start: 0, end: 0 });
  }, [restoreVersion]);
  function applyExternal() {
    if (deactivated.current || composing.current || !pendingExternal.current) return;
    const next = pendingExternal.current;
    pendingExternal.current = null;
    try {
      const raw = (persistence?.storage ?? localStorage).getItem(projectDocumentsKey(project.id));
      const disk = readProjectDocuments(project.id, { getItem: () => raw });
      const diskFingerprint = raw === null ? null : artifactFingerprint(disk);
      const unchanged = artifactFingerprint(next) === artifactFingerprint(current.current);
      // The storage already mirroring the incoming version exactly is the workspace's
      // coordinated adoption (备份草稿并接续共享版本 backed the draft up first), not a rogue overwrite.
      const coordinated = diskFingerprint !== null && artifactFingerprint(disk) === artifactFingerprint(next);
      if (!unchanged && !coordinated && (savedFingerprint.current !== artifactFingerprint(current.current) ||
        area.current?.value !== current.current.documents.find(item => item.id === current.current.activeId)?.content)) {
        throw new Error("外部版本已更新，但本地有未保存修改；当前草稿和旧存储未覆盖。请先导出或保存，再重新应用外部版本。");
      }
      // 回送相同草稿不是接管其他窗口磁盘版本的许可。
      if (unchanged && diskFingerprint !== artifactFingerprint(current.current)) return;
      baseline.current = raw; savedFingerprint.current = diskFingerprint;
      if (!unchanged) {
        history.current = new ScriptDocumentHistory<ScriptDocument>();
        replace(next);
        if (area.current) area.current.value = next.documents.find(item => item.id === next.activeId)!.content;
        onSelection?.({ documentId: next.activeId, text: "", start: 0, end: 0 });
      }
      if (diskFingerprint === artifactFingerprint(next)) pendingDrafts.delete(project.id);
      setError(""); setStatus(diskFingerprint === artifactFingerprint(next) ? "已载入外部版本" : "外部版本待保存");
    } catch (failure) { setError((failure as Error).message); }
  }
  useEffect(() => {
    if (deactivated.current || !revision || !Number.isFinite(revision) || revision <= externalRevision.current || externalState === undefined) return;
    externalRevision.current = revision;
    pendingExternal.current = null;
    try {
      const valid = validateProjectDocuments(externalState, project.id);
      if (!valid.documents.length) throw new Error("外部文档为空；当前草稿和旧存储未覆盖，请先创建一个文档再应用。");
      pendingExternal.current = JSON.parse(JSON.stringify(valid)) as ProjectDocuments;
      applyExternal();
    } catch (failure) { setError((failure as Error).message); }
  }, [revision, externalState]);
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      if (savedFingerprint.current !== artifactFingerprint(current.current)) save();
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!deactivated.current && savedFingerprint.current !== artifactFingerprint(current.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === projectDocumentsKey(project.id) || event.key === null) setError("其他窗口可能已更新文档；当前草稿保留，保存时会核对版本。请先导出再核对。");
    };
    window.addEventListener("beforeunload", beforeUnload); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("storage", storage); };
  }, [project.id]);
  useEffect(() => {
    if (selectedDocumentId && selectedDocumentId !== current.current.activeId && current.current.documents.some(item => item.id === selectedDocumentId)) select(selectedDocumentId);
  }, [selectedDocumentId, selectionRequest]);
  useEffect(() => { onSelection?.({ documentId: doc.id, text: "", start: 0, end: 0 }); }, [doc.id]);
  function select(id: string) { replace({ ...current.current, activeId: id }); }
  function selection() {
    const input = area.current;
    if (!input || composing.current) return;
    const { selectionStart: start, selectionEnd: end, value } = input;
    onSelection?.({ documentId: doc.id, text: value.slice(start, end), start, end });
  }
  function updateContent(value: string, record = true) {
    const before = current.current.documents.find(item => item.id === current.current.activeId)!;
    const next = { ...before, content: value, updatedAt: Date.now() };
    if (before.content === value) return;
    if (record && !composing.current) history.current.record(before.id, before, next);
    replace({ ...current.current, documents: current.current.documents.map(item => item.id === before.id ? next : item) });
    onSelection?.({ documentId: before.id, text: "", start: 0, end: 0 });
  }
  function move(direction: "undo" | "redo"): boolean {
    if (persistence) { persistence.history[direction](); return true; }
    const input = area.current, state = current.current;
    if (!activeRef.current || !input || composing.current) return false;
    const before = state.documents.find(item => item.id === state.activeId)!;
    const next = history.current.move(before.id, before, direction);
    if (next === undefined) { setNotice(direction === "undo" ? "没有可撤销的改稿" : "没有可重做的改稿"); return false; }
    input.value = next.content;
    replace({ ...state, documents: state.documents.map(item => item.id === next.id ? next : item) });
    onSelection?.({ documentId: next.id, text: "", start: 0, end: 0 });
    return true;
  }
  function keydown(event: KeyboardEvent<HTMLElement>) {
    if (!active || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "s") { event.preventDefault(); save(); return; }
    if (event.key === "Escape") { setPanel(null); setConsent(false); return; }
    if (event.target !== area.current) return;
    if (command && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault(); move(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo"); return;
    }
    if (event.key !== "Tab" || event.shiftKey || command || event.altKey) return;
    event.preventDefault();
    const input = area.current!;
    input.setRangeText("\t", input.selectionStart, input.selectionEnd, "end");
    updateContent(input.value); selection();
  }
  function open(next: typeof panel) { setPanel(next); setConsent(false); setTitle(next === "rename" ? doc.title : ""); setNotice(""); }
  function submitTitle() {
    if (!title.trim()) return;
    if (panel === "new") {
      const created = createScriptDocument(kind, title.trim());
      replace({ ...state, documents: [...state.documents, created], activeId: created.id });
    } else replace({ ...state, documents: state.documents.map(item => item.id === doc.id ? { ...item, title: title.trim(), updatedAt: Date.now() } : item) });
  }
  function remove() {
    if (!consent || state.documents.length < 2) return;
    const documents = state.documents.filter(item => item.id !== doc.id);
    history.current.forget(doc.id); replace({ ...state, documents, activeId: documents[0]!.id });
  }
  function download() {
    let url: string | undefined;
    try {
      const output = scriptMarkdownExport(doc); url = URL.createObjectURL(new Blob([output.content], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = output.filename; document.body.appendChild(link); link.click(); link.remove();
      const release = url; setTimeout(() => URL.revokeObjectURL(release), 1000); setNotice("已导出当前原文（含未保存修改）");
    } catch { if (url) URL.revokeObjectURL(url); setError("导出失败，请重试或全选正文复制备份；草稿未丢失。"); }
  }
  const scenes = panel === "preview" ? previewScriptScenes(doc) : [];
  return <section className="script-editor" aria-label="脚本文档编辑器" onKeyDown={keydown}
    onCompositionStartCapture={event => { formComposition.current = event.target as HTMLElement; }}
    onCompositionEndCapture={() => { formComposition.current = null; }}>
    <header className="script-editor-toolbar">
      <label className="script-document-picker">文档<select aria-label="切换脚本文档" value={doc.id} onChange={event => select(event.target.value)}>{state.documents.map(item => <option key={item.id} value={item.id}>{documentKinds[item.kind]} · {item.title}</option>)}</select></label>
      {!persistence && <button type="button" onClick={() => open("new")}>新建</button>}
      <button type="button" onClick={() => open("rename")}>重命名</button>
      <button type="button" disabled={!!persistence || state.documents.length < 2} title={state.documents.length < 2 ? "至少保留一个文档" : "删除前需确认"} onClick={() => open("delete")}>删除</button>
      <span className="script-save-status" role="status" aria-live="polite">{status}</span>
      <button type="button" onClick={save}>保存</button><button type="button" onClick={download}>导出 .md</button>
    </header>
    {error && <div className="script-editor-error" role="alert"><span>{error}</span><button type="button" onClick={save}>重试保存</button></div>}
    {(panel === "new" || panel === "rename") && <form className="script-editor-inline" onSubmit={event => { event.preventDefault(); submitTitle(); }}>
      {panel === "new" && <label>类型<select aria-label="新文档类型" value={kind} onChange={event => setKind(event.target.value as ScriptDocument["kind"])}>{Object.entries(documentKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      <label>名称<input ref={titleInput} autoFocus aria-label="文档名称" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <button type="submit" disabled={!title.trim()} title={!title.trim() ? "请填写文档名称" : undefined}>确定</button><button type="button" onClick={() => setPanel(null)}>取消</button>
    </form>}
    {panel === "delete" && <div className="script-editor-inline" role="group" aria-label="确认删除文档">
      <p>删除「{doc.title}」？保存后将从本机文档移除；请先导出需要保留的原文。</p>
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我确认删除此文档</label>
      <button type="button" disabled={!consent} title={!consent ? "请先勾选删除确认" : undefined} onClick={remove}>确认删除</button><button type="button" onClick={() => setPanel(null)}>取消</button>
    </div>}
    <div className="script-editor-heading"><span>{documentKinds[doc.kind]} / 纯文本 Markdown</span><span>正文独立保存，不会自动改动画面</span></div>
    <textarea key={doc.id} ref={area} className="script-editor-body" aria-label="脚本文档正文" aria-describedby="script-editor-hint" defaultValue={doc.content} spellCheck={false}
      placeholder="从一句中文开始。可用 ## 镜头 1 或 ## 场景 1 组织内容，也可直接编写大纲、角色与对白。"
      onChange={event => updateContent(event.target.value)} onSelect={selection} onKeyUp={selection} onMouseUp={selection}
      onCompositionStart={() => { composing.current = true; compositionBefore.current = { ...current.current.documents.find(item => item.id === current.current.activeId)! }; }}
      onCompositionEnd={event => {
        updateContent(event.currentTarget.value);
        composing.current = false;
        const before = compositionBefore.current, next = current.current.documents.find(item => item.id === before?.id);
        if (before && next) history.current.record(before.id, before, next);
        compositionBefore.current = null;
        setState({ ...current.current });
        historyCallback.current?.(history.current.status(current.current.activeId)); selection();
        applyExternal();
      }} />
    <footer className="script-editor-footer"><span id="script-editor-hint">Ctrl/⌘ S 保存 · Tab 插入制表符 · Shift+Tab 离开正文</span>
      <span>{doc.content.length.toLocaleString()} 字符</span><button type="button" onClick={() => move("undo")}>撤销改稿</button><button type="button" onClick={() => move("redo")}>重做改稿</button>
      <button type="button" onClick={() => open("preview")}>预览拆分镜头</button></footer>
    {notice && <p className="script-editor-notice" role="status">{notice}</p>}
    {panel === "preview" && <div className="script-scene-preview" role="region" aria-label="脚本分镜预览">
      <h3>分镜预览 · {scenes.length} 个片段</h3><p>按标题拆成镜头，正文作为旁白。确认后创建一份新作品，当前画面保留。</p>
      {!scenes.length ? <p>暂无可拆分正文。请先输入旁白，或使用「## 镜头 / 场景」标题。</p> : <ol>{scenes.map((scene, i) => <li key={i}><strong>{scene.title}</strong><pre>{scene.narration}</pre></li>)}</ol>}
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我已核对，确认将当前文档交给分镜流程</label>
      <div className="script-editor-inline"><button type="button" className="script-build-button" disabled={!consent || !scenes.length || !onBuildScenes} title={!onBuildScenes ? "请先打开项目" : !consent ? "请先核对预览并勾选确认" : !scenes.length ? "请输入可拆分正文" : undefined} onClick={() => {
        if (!consent || !scenes.length || !onBuildScenes) return;
        try { onBuildScenes({ ...doc }); setPanel(null); setConsent(false); setNotice("已发送当前文档；画面变更仍由主线确认。"); }
        catch { setError("分镜流程未接收成功；正文未变，请重试。"); }
      }}>确认交给分镜流程</button><button type="button" onClick={() => setPanel(null)}>取消</button></div>
    </div>}
  </section>;
}
