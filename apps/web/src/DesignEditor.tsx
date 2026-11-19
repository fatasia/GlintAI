import type { AuthoringPersistence } from "./authoring-persistence";
import { DesignTaskPanel } from "./DesignTaskPanel";
import { applicationUrl, appFetch } from "./app-url";
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createDesignDocument, designId, designKinds, reorderDesignPages, updateDesignDocument, DESIGN_HTML_LIMIT, DESIGN_PAGE_LIMIT, DESIGN_ANNOTATION_LIMIT, type DesignAnnotation, type DesignDocument, type DesignExportContext, type DesignKind, type DesignPage, type DesignSelection, type ProjectDesignDocuments } from "./design-artifacts";
import { applyDesignGesture, describeDesignNode, normalizeDesignHtml, patchDesignNodes, type DesignPatch } from "./design-editor-dom";
import type { DesignBridgeMessage } from "./design-editor-bridge";
import { DesignPreview, DesignThumb, designViewports } from "./design-editor-preview";
import { DesignInspector } from "./design-editor-inspector";
import { DesignPageRail } from "./design-editor-pages";
import { useDesignDocuments } from "./design-editor-state";
import { DesignTransitionControls, DesignTransitionPlayer, type TransitionPlay } from "./design-editor-transitions";
import { designTransitionLabels, presentTransition, type DesignTransition } from "./design-transition";
import type { DesignPageTransition } from "./design-artifacts";
import { selectedImageSrc } from "./design-mask-edit";
import { assertAuthoringCanLeave, useAuthoringLeaveGuard } from "./authoring-leave";
import { assetAlt, fileToDataUrl, insertDesignImage, readLibrary, readProjectAssets, rememberProjectAsset, replaceDesignImage, urlToDataUrl, type LibraryAsset } from "./design-assets";
import { clearProjectBrand, pinBrandToProject, readBrandTheme } from "./design-brand";
import { artifactFingerprint, designAnnotationRequest, validateArtifactProposal, type ArtifactEditRequest, type DesignEditHandle } from "./artifact-project";
import "./design-editor.css";
const QuickImage = lazy(() => import("./QuickImage").then(module => ({ default: module.QuickImage })));
const MaskEditor = lazy(() => import("./design-mask-editor").then(module => ({ default: module.DesignMaskEditor })));
export interface DesignEditorProps {
  projectId: string; persistence?: AuthoringPersistence;
  title?: string;
  initialKind?: DesignKind;
  openTarget?: { id: string; pageId?: string; nonce: number };
  externalState?: ProjectDesignDocuments;
  revision?: number;
  onSelection?: (context: DesignSelection) => void;
  onDocumentsChange?: (state: ProjectDesignDocuments) => void;
  onExport?: (context: DesignExportContext) => void | Promise<void>;
  onVideo?: (document: DesignDocument) => void | Promise<void>;
  onReview?: (request: ArtifactEditRequest) => void;
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  editHandle?: { current: DesignEditHandle | null };
}
export function DesignEditor(props: DesignEditorProps) { return <DesignWorkspace key={props.projectId} {...props} />; }
export default DesignEditor;
function DesignWorkspace({ projectId, persistence, title, openTarget, initialKind, externalState, revision, onSelection, onDocumentsChange, onExport, onVideo, onReview, onHistoryChange, editHandle }: DesignEditorProps) {
  const model = useDesignDocuments(projectId, title, onDocumentsChange, externalState, revision, initialKind, persistence), { state } = model;
  const doc = state.documents.find(item => item.id === state.activeId)!, page = doc.pages.find(item => item.id === doc.activePageId)!;
  const [mode, setMode] = useState<"visual" | "source">("visual"), [viewport, setViewport] = useState<keyof typeof designViewports>("desktop");
  const [interactive, setInteractive] = useState(false), [presenting, setPresenting] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState(""), [exporting, setExporting] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [taskOpen,setTaskOpen]=useState(false);
  const [pageTransition, setPageTransition] = useState<TransitionPlay | null>(null), [transitionPreview, setTransitionPreview] = useState(false), [previewNonce, setPreviewNonce] = useState(0);
  const pageTransitionRef = useRef<TransitionPlay | null>(null), transitioning = useRef(false);
  const [inlineText,setInlineText]=useState<{documentId:string;pageId:string;nodeId:string;baseHtml:string;text:string;x:number;y:number;width:number;height:number}|null>(null);
  useEffect(() => {
    if (!openTarget) return;
    const current = model.current.current;
    const target = current.documents.find(item => item.id === openTarget.id);
    if (!target || !target.pages.some(item => item.id === openTarget.pageId)) return;
    if(current.activeId===target.id && target.activePageId===openTarget.pageId)return;
    if (!prepareNavigation()) return;
    model.replace({ ...current, activeId: target.id, documents: current.documents.map(item => item.id === target.id ? { ...item, activePageId: openTarget.pageId! } : item) }, false);
    // Explicit project navigation is a saved selection, not a delayed content draft.
    model.save();
  }, [openTarget?.nonce]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const assetRequest = useRef<AbortController | null>(null);
  const view = useRef({ docId: doc.id, pageId: page.id, html: page.html, selected }); view.current = { docId: doc.id, pageId: page.id, html: page.html, selected };
  useEffect(() => () => { assetRequest.current?.abort(); }, []);
  const [comparing, setComparing] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [maskNodeId, setMaskNodeId] = useState<string | null>(null);
  const [generateImage, setGenerateImage] = useState(false);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [projectAssets, setProjectAssets] = useState<LibraryAsset[]>([]);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [draft, setDraft] = useState<{ id?: string; x: number; y: number; text: string; nodeId?: string } | null>(null);
  const [newKind, setNewKind] = useState<DesignKind>("page"), [newTitle, setNewTitle] = useState(""), [creating, setCreating] = useState(false);
  const [pageTitle, setPageTitle] = useState(page.title), [documentTitle, setDocumentTitle] = useState(doc.title);
  const source = model.source, root = useRef<HTMLElement>(null);
  const formComposition = useRef<HTMLElement | null>(null);
  useAuthoringLeaveGuard(projectId, () => {
    if(inlineText) throw new Error("画面文字尚未应用，请先应用或取消直接编辑。");
    if (model.composing.current || formComposition.current?.isConnected)
      throw new Error("请先完成中文输入，再离开设计编辑器。");
    if (draft) throw new Error("设计批注尚未保存；请先保存批注或取消，再离开编辑器。");
    if (creating && (newKind !== "page" || root.current?.querySelector<HTMLInputElement>('[aria-label="新设计名称"]')?.value))
      throw new Error("新设计名称尚未提交；请先创建设计或取消，再离开编辑器。");
    const current = model.current.current, document = current.documents.find(item => item.id === current.activeId)!;
    const currentPage = document.pages.find(item => item.id === document.activePageId)!;
    for (const [label, value] of [["设计文档标题", document.title], ["页面标题", currentPage.title], ["演讲备注", currentPage.notes ?? ""]]) {
      const input = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
      if (input && input.value !== value) throw new Error(`${label}尚未保存；请先提交输入或取消，再离开编辑器。`);
    }
    model.assertSaved();
  });
  const navigationTarget=useRef<string|null>(null);
  const callback = useRef(onSelection); callback.current = onSelection;
  useEffect(() => { setSelected([]); if(navigationTarget.current!==page.id)setInteractive(false);navigationTarget.current=null; setDraft(null); setReviewIds([]); setCommentMode(false); setPageTitle(page.title); setDocumentTitle(doc.title); assetRequest.current?.abort(); setAssetBusy(false); callback.current?.({ documentId: doc.id, pageId: page.id, nodeId: "", nodeIds: [], text: "" }); }, [doc.id, page.id]);
  useEffect(() => {
    if (!editHandle) return;
    let live = true;
    const handle: DesignEditHandle = {
      prepareDeactivate(expected) {
        if (!live) throw new Error("设计编辑器已卸载，停用未准备；请重新打开工程。");
        const accept = model.prepareDeactivate(expected);
        return () => { if (live) accept(); };
      },
      prepareRestore(next, expected) {
        if (!live) throw new Error("设计编辑器已卸载，恢复未准备；请重新打开工程。");
        const accept = model.prepareRestore(next, expected);
        return () => { if (live) accept(); };
      },
      get canUndo() { return model.historyRef.current.canUndo; },
      get canRedo() { return model.historyRef.current.canRedo; },
      undo() { if (live) model.move("undo"); },
      redo() { if (live) model.move("redo"); },
      apply(before, next) {
        if (!live) throw new Error("设计编辑器已卸载，提案未应用。");
        const current = model.current.current, existing = current.documents.find(item => item.id === before.id);
        if (!existing || artifactFingerprint(existing) !== artifactFingerprint(before)) throw new Error("文档已变化，提案未应用；请基于当前版本重新生成。");
        if (model.composing.current) throw new Error("请先完成中文输入，再应用提案。");
        const base = { schemaVersion: 1 as const, id: projectId, title: title || "当前工程", document: before };
        validateArtifactProposal(base, { ...base, document: next });
        model.replace(updateDesignDocument(current, next));
        setSelected([]); setNotice("AI 提案已作为一次修改应用，可一次撤销。"); return true;
      }
    };
    editHandle.current = handle;
    return () => { live = false; if (editHandle.current === handle) editHandle.current = null; };
  }, [editHandle, projectId, title]);
  const historyCallback = useRef(onHistoryChange); historyCallback.current = onHistoryChange;
  useEffect(() => { historyCallback.current?.({ canUndo: model.history.canUndo, canRedo: model.history.canRedo }); }, [state, model.history]);
  useEffect(() => { setReviewIds(ids => ids.filter(id => page.annotations?.some(mark => mark.id === id))); }, [page.annotations]);
  useEffect(() => {
    if (!model.restoreVersion) return;
    const state = model.current.current, doc = state.documents.find(item => item.id === state.activeId)!;
    setSelected([]); setDraft(null); setReviewIds([]); setCommentMode(false); setInteractive(false); setNotice("");
    setPageTitle(doc.pages.find(page => page.id === doc.activePageId)!.title); setDocumentTitle(doc.title);
    callback.current?.({ documentId: doc.id, pageId: doc.activePageId, nodeId: "", nodeIds: [], text: "" });
  }, [model.restoreVersion]);
  // Selecting something on the canvas is a request to edit it: reveal properties, never the other way round.
  useEffect(() => { if (selected.length) setInspectorOpen(true); }, [selected]);
  useEffect(() => { setPageTitle(page.title); setDocumentTitle(doc.title); }, [page.title, doc.title]);
  function prepareNavigation(): boolean {
    try { model.save(); assertAuthoringCanLeave([projectId]); return true; }
    catch (error) { model.setError(error instanceof Error ? error.message : "当前输入尚未保存，未切换页面。"); return false; }
  }
  function documentChange(next: DesignDocument, record = true) {
    const current = model.current.current, active = current.documents.find(item => item.id === current.activeId)!;
    if ((next.id !== active.id || next.activePageId !== active.activePageId) && !prepareNavigation()) return;
    model.replace(updateDesignDocument(current, next), record);
  }
  function pageChange(patch: Partial<DesignPage>) {
    const activeDoc = model.current.current.documents.find(item => item.id === model.current.current.activeId)!;
    documentChange({ ...activeDoc, pages: activeDoc.pages.map(item => item.id === activeDoc.activePageId ? { ...item, ...patch } : item) });
  }
  function selection(ids: string[], text?: string) {
    const valid = ids.filter(id => describeDesignNode(page.html, id));
    if (valid.join("\0") !== selected.join("\0") && !prepareNavigation()) return;
    setSelected(valid);
    const node = valid[0] ? describeDesignNode(page.html, valid[0]) : undefined;
    onSelection?.({ documentId: doc.id, pageId: page.id, nodeId: node?.id ?? "", nodeIds: valid, text: node?.text ?? text ?? "", tagName: node?.tagName, editable: Boolean(node && !node.locked) });
  }
  const brandState = readBrandTheme(projectId), brand = brandState.theme;
  async function refreshAssets() {
    assetRequest.current?.abort(); const controller = new AbortController(); assetRequest.current = controller;
    setAssetError(""); setAssetBusy(true); setProjectAssets(readProjectAssets(projectId));
    try { const next = await readLibrary(controller.signal,true); if (!controller.signal.aborted) setAssets(next); }
    catch (error) { if (!controller.signal.aborted) setAssetError(error instanceof Error ? error.message : "素材库读取失败。"); }
    finally { if (assetRequest.current === controller) { assetRequest.current = null; setAssetBusy(false); } }
  }
  function closeAssets() {
    assetRequest.current?.abort(); assetRequest.current = null;
    setAssetOpen(false); setAssetBusy(false);
  }
  function openAssets() {
    if (assetOpen) { closeAssets(); return; }
    setAssets([]); setAssetOpen(true); void refreshAssets();
  }
  function applyAsset(src: string, alt: string, target: typeof view.current) {
    const active = view.current;
    if (active.docId !== target.docId || active.pageId !== target.pageId || active.html !== target.html || artifactFingerprint(active.selected) !== artifactFingerprint(target.selected)) throw new Error("读取期间页面或选区已变化，未写入图片；请在目标位置重新选择。");
    model.save(); assertAuthoringCanLeave([projectId]);
    const nodeId = target.selected[0], node = nodeId ? describeDesignNode(target.html, nodeId) : undefined;
    if (nodeId && node?.tagName === "img") { pageChange({ html: replaceDesignImage(target.html, nodeId, src) }); setNotice("已替换选中图片，布局保持不变。"); }
    else { const result = insertDesignImage(target.html, src, alt); pageChange({ html: result.html }); setSelected([result.nodeId]); setNotice("图片已插入页面，可拖动或用属性面板调整。"); }
    setAssetOpen(false); setAssetError("");
  }
  async function pickFile(file: File | null | undefined) {
    if (!file) return;
    const target = { ...view.current, selected: [...view.current.selected] };
    assetRequest.current?.abort(); const controller = new AbortController(); assetRequest.current = controller;
    setAssetBusy(true); setAssetError("");
    try { const src = await fileToDataUrl(file,true); if (!controller.signal.aborted) applyAsset(src, assetAlt(file.name), target); }
    catch (error) { if (!controller.signal.aborted) setAssetError(error instanceof Error ? error.message : "图片读取失败。"); }
    finally { if (assetRequest.current === controller) { assetRequest.current = null; setAssetBusy(false); } }
  }
  async function pickLibrary(asset: LibraryAsset) {
    const target = { ...view.current, selected: [...view.current.selected] };
    assetRequest.current?.abort(); const controller = new AbortController(); assetRequest.current = controller;
    setAssetBusy(true); setAssetError("");
    try {
      const src = await urlToDataUrl(asset.url, controller.signal,true);controller.signal.throwIfAborted();let picked=asset;
      if(asset.bytes>512*1024){
        const [header,data]=src.split(','),type=header!.slice(5,header!.indexOf(';')),bytes=Uint8Array.from(atob(data!),char=>char.charCodeAt(0));
        const response=await appFetch('/api/media/import-image',{method:'POST',headers:{'content-type':type},body:bytes,signal:controller.signal});const result=await response.json();
        if(!response.ok||typeof result.name!=='string'||!/^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(result.name))throw new Error('优化副本未能保存，原图保留。');
        picked={name:result.name,url:`/api/media/assets/${result.name}`,bytes:bytes.length};
      }
      controller.signal.throwIfAborted();applyAsset(src,assetAlt(asset.name),target);setProjectAssets(rememberProjectAsset(projectId,picked));
      if(asset.bytes>512*1024)setNotice('已插入优化副本；素材库原图保留。');
    }
    catch (error) { if (!controller.signal.aborted) setAssetError(error instanceof Error ? error.message : "素材读取失败。"); }
    finally { if (assetRequest.current === controller) { assetRequest.current = null; setAssetBusy(false); } }
  }
  function adoptScheme(id: string) { if (id !== model.current.current.activeId && !prepareNavigation()) return; model.replace({ ...model.current.current, activeId: id }, false); setComparing(false); setNotice("已切换到该方向，可继续编辑。"); }
  function duplicateScheme(id: string) {
    const current = model.current.current, source = current.documents.find(item => item.id === id);
    if (!source || !prepareNavigation()) return;
    const pages = source.pages.map(item => ({ ...item, id: designId(), annotations: item.annotations?.map(mark => ({ ...mark, id: designId() })) }));
    const copy: DesignDocument = { ...source, id: designId(), title: `${source.title} · 新方向`, pages, activePageId: pages[0]!.id, updatedAt: Date.now() };
    model.replace({ ...current, documents: [...current.documents, copy], activeId: copy.id });
    setNotice("已复制为一个新方向，可以改文案或版式后再比较。");
  }
  function removeScheme(id: string) {
    const current = model.current.current;
    if (current.documents.length < 2) { model.setError("至少保留一个方案。"); return; }
    if (id === current.activeId && !prepareNavigation()) return;
    const documents = current.documents.filter(item => item.id !== id);
    model.replace({ ...current, documents, activeId: current.activeId === id ? documents[0]!.id : current.activeId });
    setNotice("方案已删除，可撤销。");
  }
  function reviewAnnotations() {
    if (!onReview) return;
    try { onReview(designAnnotationRequest(projectId, doc, reviewIds)); setNotice("已把选中批注送入右侧助手草稿；核对后生成提案，不会自动执行。"); }
    catch (error) { model.setError(error instanceof Error ? error.message : "批注提交失败。"); }
  }
  function saveAnnotation() {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) { setNotice("批注内容为空，未保存。"); return; }
    const list = page.annotations ?? [];
    if (!draft.id && list.length >= DESIGN_ANNOTATION_LIMIT) { model.setError("每页最多 200 条批注，请先整理已有批注。"); return; }
    const next: DesignAnnotation[] = draft.id
      ? list.map(mark => mark.id === draft.id ? { ...mark, text } : mark)
      : [...list, { id: designId(), x: draft.x, y: draft.y, text, ...(draft.nodeId ? { nodeId: draft.nodeId } : {}), createdAt: Date.now() }];
    pageChange({ annotations: next }); setDraft(null); setNotice(draft.id ? "批注已更新。" : "批注已保存，可继续点其他位置。");
  }
  function removeAnnotation(id: string) {
    pageChange({ annotations: (page.annotations ?? []).filter(mark => mark.id !== id) });
    setDraft(current => current?.id === id ? null : current);
  }
  function patch(patch: DesignPatch) {
    try { pageChange({ html: patchDesignNodes(page.html, selected, patch) }); setNotice("属性已应用 · 可撤销"); }
    catch (error) { model.setError((error as Error).message); }
  }
  function applyInlineText() {
    if(!inlineText)return;
    try {
      if(doc.id!==inlineText.documentId || page.id!==inlineText.pageId || page.html!==inlineText.baseHtml)
        throw new Error("原页面已有变化，未覆盖新修改。请复制保留文字后取消，再重新点选编辑。");
      pageChange({html:patchDesignNodes(page.html,[inlineText.nodeId],{text:inlineText.text})});
      setInlineText(null);setNotice("文字已应用 · 可撤销");
    } catch(error) {model.setError(error instanceof Error?error.message:"文字未能应用。");}
  }
  function message(data: DesignBridgeMessage) {
    if(data.action === "navigate" && (interactive || presenting)) {
      try {
        const target=doc.pages.find(item=>item.id===data.pageId);
        if(!target)throw new Error("目标页面已不存在，请检查链接。");
        if(target.id===page.id)return;
        model.save();assertAuthoringCanLeave([projectId]);
        navigationTarget.current=target.id;goToPage(target);
      }catch(error){navigationTarget.current=null;model.setError(error instanceof Error?error.message:"页面跳转失败。");}
    }
    if(data.action === "edit" && !commentMode && !interactive && !presenting) {
      if(inlineText){model.setError("请先应用或取消当前文字编辑。");return;}
      const node=data.nodeId ? describeDesignNode(page.html,data.nodeId) : undefined;
      if(node?.textEditable && !node.locked) setInlineText({documentId:doc.id,pageId:page.id,nodeId:node.id,baseHtml:page.html,text:node.text,x:data.x!,y:data.y!,width:data.width!,height:data.height!});
    }
    if (data.action === "select") { selection(data.nodeIds ?? [], data.text); if (!data.nodeIds?.length) setNotice("运行态节点无法定位到静态源码；请使用源码模式编辑。"); }
    if (data.action === "clear") selection([]);
    if (data.action === "comment" && commentMode && !interactive && !presenting) { setDraft({ x: data.x ?? 0, y: data.y ?? 0, text: "", nodeId: data.nodeId }); setNotice("在下方填写批注，保存后会钉在这个位置。"); }
    if (data.action === "error") setNotice(data.text || "预览操作被安全策略阻止。");
    if (data.action === "gesture" && !commentMode && !interactive && !presenting) {
      try { pageChange({ html: applyDesignGesture(page.html, data.nodeIds ?? [], { dx: data.dx!, dy: data.dy!, width: data.width, height: data.height, rotation: data.rotation }) }); setNotice(data.rotation !== undefined ? "元素已旋转 · 可撤销" : data.width === undefined ? "元素已移动 · 可撤销" : "尺寸已调整 · 可撤销"); }
      catch (error) { model.setError((error as Error).message); }
    }
  }
  function addPage(copy = false) {
    if (doc.pages.length >= DESIGN_PAGE_LIMIT) return;
    const next: DesignPage = copy ? { ...page, id: designId(), title: `${page.title} 副本` } : { ...createDesignDocument(doc.kind).pages[0]!, id: designId(), title: `新${doc.kind === "slides" ? "幻灯片" : "页面"} ${doc.pages.length + 1}` };
    const pages = [...doc.pages]; pages.splice(pages.findIndex(item => item.id === page.id) + 1, 0, next); documentChange({ ...doc, pages, activePageId: next.id });
  }
  function removePage() { if (doc.pages.length < 2) return; const pages = doc.pages.filter(item => item.id !== page.id); documentChange({ ...doc, pages, activePageId: pages[0]!.id }); }
  function importHtml(name: string, html: string) {
    try {
      if (doc.pages.length >= DESIGN_PAGE_LIMIT) throw new Error("最多保留 100 页，请先整理再导入。");
      const next: DesignPage = { id: designId(), title: name || "导入页面", html: normalizeDesignHtml(html), notes: "" };
      documentChange({ ...doc, pages: [...doc.pages, next], activePageId: next.id }); setNotice("HTML 已作为新页导入；内联脚本仅在隔离预览中运行，外部资源受限。");
    } catch (error) { model.setError((error as Error).message); }
  }
  function movePage(delta: number) {
    const index = doc.pages.findIndex(item => item.id === page.id), next = doc.pages[index + delta]; if (next) goToPage(next);
  }
  // Presenting navigation: play the target page's transition on stacked frames, then commit once.
  function goToPage(target: DesignPage) {
    if (transitioning.current || target.id === page.id) return;
    const fromIndex = doc.pages.findIndex(item => item.id === page.id);
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const play = presenting && fromIndex >= 0 && !reducedMotion ? presentTransition(target) : undefined;
    if (!play) { documentChange({ ...doc, activePageId: target.id }, false); return; }
    transitioning.current = true;
    const next: TransitionPlay = { from: doc.pages[fromIndex]!, to: target, transition: play };
    pageTransitionRef.current = next; setPageTransition(next);
  }
  function commitTransition() {
    const played = pageTransitionRef.current;
    pageTransitionRef.current = null; transitioning.current = false; setPageTransition(null);
    if (!played) return;
    const current = model.current.current, active = current.documents.find(item => item.id === current.activeId)!;
    const target = active.pages.find(item => item.id === played.to.id);
    if (target && target.id !== active.activePageId) documentChange({ ...active, activePageId: target.id }, false);
  }
  function cancelTransition() {
    pageTransitionRef.current = null; transitioning.current = false; setPageTransition(null); setTransitionPreview(false);
  }
  function transitionChange(patch: { transition?: DesignPageTransition; stepReveal?: boolean }) {
    if (patch.transition !== undefined) pageChange({ transition: patch.transition });
    if (patch.stepReveal !== undefined) pageChange({ stepReveal: patch.stepReveal });
  }
  function applyTransitionToAll(transition: DesignTransition) {
    documentChange({ ...doc, pages: doc.pages.map(item => ({ ...item, transition })) });
    setNotice("转场已应用到全部页 · 可一次撤销");
  }
  function keydown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || model.composing.current || event.keyCode === 229) return;
    if (event.key === "Escape") { cancelTransition(); setPresenting(false); setCreating(false); selection([]); return; }
    if (presenting && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); movePage(event.key === "ArrowLeft" ? -1 : 1); return; }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") { event.preventDefault(); model.save(); }
    if (["z", "y"].includes(key) && (event.target === source.current || !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName))) { event.preventDefault(); model.move(key === "y" || event.shiftKey ? "redo" : "undo"); }
  }
  async function exportCurrent() {
    if (!onExport || exporting) return; setExporting(true); setNotice("正在准备导出…");
    try { await onExport({ state: model.current.current, document: doc, page }); setNotice("已交给导出面板；请在面板中选择格式。"); }
    catch { model.setError("导出面板打开失败；草稿未变，请重试。"); }
    finally { setExporting(false); }
  }
  return <section ref={root} className={`design-editor${presenting ? " design-presenting" : ""}`} aria-label="设计文档编辑器" onKeyDown={keydown} tabIndex={-1}
    onCompositionStartCapture={event => { formComposition.current = event.target as HTMLElement; }}
    onCompositionEndCapture={() => { formComposition.current = null; }}>
    <header className="design-toolbar">
      <label className="design-document-picker">设计文档<select aria-label="切换设计文档" value={doc.id} onChange={event => { if (!prepareNavigation()) return; model.replace({ ...state, activeId: event.target.value }, false); setPresenting(false); }}>{state.documents.map(item => <option key={item.id} value={item.id}>{designKinds[item.kind]} · {item.title}</option>)}</select></label>
      <button type="button" onClick={()=>setTaskOpen(value=>!value)}>连续设计</button>
      <span className="design-kind">{designKinds[doc.kind]}</span>{!persistence && <button type="button" onClick={() => setCreating(value => !value)}>新建设计</button>}
      <button type="button" onClick={() => model.move("undo")} disabled={!model.history.canUndo} title={!model.history.canUndo ? "没有可撤销的修改" : "撤销源码或可视修改"}>撤销</button><button type="button" onClick={() => model.move("redo")} disabled={!model.history.canRedo} title={!model.history.canRedo ? "没有可重做的修改" : "重做修改"}>重做</button>
      <span className="design-save-status" role="status">{model.status}</span><button type="button" onClick={model.save}>保存</button>
      <button type="button" disabled={!onExport || exporting} title={!onExport ? "等待主线接入导出面板" : exporting ? "正在准备导出" : "导出当前设计文档"} onClick={() => { void exportCurrent(); }}>导出</button>
      {doc.kind === "slides" && onVideo && <button type="button" disabled={videoBusy} title="无动画页转换为图片镜头，设置了对象入场的页面保留动画；备注作为旁白，设计原稿保留" onClick={async () => {
        setVideoBusy(true);
        try { const current=model.current.current; await onVideo(structuredClone(current.documents.find(item=>item.id===current.activeId)!)); }
        catch(error) {model.setError(error instanceof Error ? error.message : "转换失败，原稿未变。");}
        finally {setVideoBusy(false);}
      }}>{videoBusy ? "正在转换…" : "加入视频"}</button>}
      {brand && <details className="design-brand-menu">
        <summary className="g-chip design-brand-chip" title="品牌变量已应用到本页的 --accent 与 --brand-* 变量">品牌 · {brand.name}{brandState.source === "project" ? " · 本项目" : ""}</summary>
        <div className="g-menu">
          <span className="g-label">品牌来源</span>
          <small>{brandState.source === "project" ? "本项目已固定使用这套品牌。" : "当前跟随品牌工坊的全局草稿。"}</small>
          {brandState.source !== "project" && <button type="button" onClick={() => { try { pinBrandToProject(projectId, brand); setNotice("已把当前品牌固定到本项目。"); } catch (error) { model.setError(error instanceof Error ? error.message : "固定失败。"); } }}>固定到本项目</button>}
          {brandState.source === "project" && <button type="button" onClick={() => { clearProjectBrand(projectId); setNotice("已恢复跟随全局品牌。"); }}>改回跟随全局</button>}
        </div>
      </details>}
      <button type="button" className="design-image-toggle" aria-pressed={assetOpen} title="插入本机图片或素材库图片；会内联进页面" onClick={() => void openAssets()}>图片</button>
      <button type="button" className="design-compare-toggle" aria-pressed={comparing} title="并排比较所有方案，选一个继续" onClick={() => { setComparing(value => !value); setDraft(null); }}>比较 {state.documents.length}</button>
      <button type="button" className="design-comment-toggle" aria-pressed={commentMode} title={commentMode ? "退出批注模式" : "在画面上点一个位置留意见"} onClick={() => { setCommentMode(value => !value); setInteractive(false); setPresenting(false); setMode("visual"); setDraft(null); }}>批注{(page.annotations?.length ?? 0) > 0 ? ` ${page.annotations!.length}` : ""}</button>
      <button type="button" className="design-inspector-toggle" aria-pressed={inspectorOpen} title={inspectorOpen ? "收起属性面板，把画面留出来" : "展开属性面板"} onClick={() => setInspectorOpen(value => !value)}>属性</button>
    </header>
    {taskOpen&&<dialog className="design-task-dialog" aria-label="整稿生成" onCancel={event=>{try{assertAuthoringCanLeave([projectId]);}catch(error){event.preventDefault();model.setError(error instanceof Error?error.message:"请先保存任务成果。");}}} ref={node=>{if(node&&!node.open)node.showModal();}} onClose={()=>setTaskOpen(false)}><DesignTaskPanel projectId={projectId} onClose={()=>setTaskOpen(false)} onAdopt={document=>{
      assertAuthoringCanLeave([projectId]);const current=model.current.current;
      if(current.documents.some(item=>item.id===document.id)){model.replace({...current,activeId:document.id},false);model.save();model.assertSaved();setTaskOpen(false);setNotice("已打开先前加入的整稿，未创建重复文档。");return;}
      if(current.documents.length>=32||current.documents.reduce((sum,item)=>sum+item.pages.length,0)+document.pages.length>100)throw new Error("项目已达到 32 份设计或 100 页上限，请拆分项目。");
      model.replace({...current,documents:[...current.documents,{...document,updatedAt:Date.now()}],activeId:document.id});model.save();model.assertSaved();setTaskOpen(false);setNotice("整稿已加入项目，可继续逐页编辑或一次撤销。");
    }}/></dialog>}
    {inlineText && (mode!=="visual" || inlineText.documentId!==doc.id || inlineText.pageId!==page.id) && <section aria-label="保留的直接编辑草稿"><p>画面文字尚未应用；原稿变化时不会覆盖新版本。</p><textarea aria-label="保留的画面文字" value={inlineText.text} onChange={event=>setInlineText({...inlineText,text:event.target.value})}/><button type="button" onClick={applyInlineText}>应用文字</button><button type="button" onClick={()=>setInlineText(null)}>取消直接编辑</button></section>}
    {model.error && <div className="design-error" role="alert"><span>{model.error}</span><button type="button" onClick={model.save}>重试保存</button></div>}
    {transitionPreview && (() => {
      const index = doc.pages.findIndex(item => item.id === page.id), from = doc.pages[index - 1], transition = presentTransition(page);
      if (!from || !transition) return null;
      return <dialog className="design-transition-dialog" aria-label="试播页面转场" ref={node => { if (node && !node.open) node.showModal(); }} onClose={() => setTransitionPreview(false)}>
        <header><strong>试播转场 · {designTransitionLabels[transition.type]} {transition.durationMs}ms</strong><span className="g-label">{from.title} → {page.title}</span></header>
        <div className="design-transition-stage"><DesignTransitionPlayer key={previewNonce} play={{ from, to: page, transition }} interactive={false} onMessage={() => { }} onFinished={() => { }} brand={brand} /></div>
        <footer><button type="button" onClick={() => setPreviewNonce(value => value + 1)}>重播</button><button type="button" onClick={() => setTransitionPreview(false)}>关闭</button></footer>
      </dialog>;
    })()}
    {creating && <form className="design-inline-form" onSubmit={event => { event.preventDefault(); const next = createDesignDocument(newKind, newTitle.trim() || `新${designKinds[newKind]}`); model.replace({ ...state, documents: [...state.documents, next], activeId: next.id }); setCreating(false); setNewTitle(""); }}>
      <label>类型<select aria-label="新设计类型" value={newKind} onChange={event => setNewKind(event.target.value as DesignKind)}>{Object.entries(designKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label>名称<input aria-label="新设计名称" value={newTitle} onChange={event => setNewTitle(event.target.value)} /></label><button type="submit">创建设计</button><button type="button" onClick={() => setCreating(false)}>取消</button>
    </form>}
    {comparing ? <section className="design-compare" aria-label="方案比较">
      <header className="design-compare-head"><span className="g-label">方案比较</span><strong className="g-num">{state.documents.length} 个方向</strong><span className="design-compare-hint">选一个继续改，或复制成新方向再试。</span><button type="button" onClick={() => setComparing(false)}>返回编辑</button></header>
      <div className="design-compare-grid">
        {state.documents.map(item => {
          const page = item.pages.find(entry => entry.id === item.activePageId) ?? item.pages[0]!;
          return <article key={item.id} className="design-compare-card" data-active={item.id === state.activeId}>
            <div className="design-compare-frame"><DesignThumb html={page.html} title={`${item.title} 预览`} brand={brand} viewport={item.kind === "slides" ? "slides" : "desktop"} /></div>
            <div className="design-compare-meta"><strong>{item.title}</strong><small>{designKinds[item.kind]} · {item.pages.length} 页{page.annotations?.length ? ` · ${page.annotations.length} 条批注` : ""}</small></div>
            <div className="design-compare-actions">
              <button type="button" className={item.id === state.activeId ? "design-primary" : ""} onClick={() => adoptScheme(item.id)}>{item.id === state.activeId ? "当前方案" : "继续这个方向"}</button>
              <button type="button" onClick={() => duplicateScheme(item.id)}>复制成新方向</button>
              {state.documents.length > 1 && <button type="button" onClick={() => removeScheme(item.id)}>删除</button>}
            </div>
          </article>;
        })}
      </div>
    </section> : <div className="design-workspace" data-inspector={inspectorOpen ? "open" : "closed"}>
      <DesignPageRail key={doc.id} document={doc} onSelect={id => documentChange({ ...doc, activePageId: id }, false)} onAdd={() => addPage()} onDuplicate={() => addPage(true)} onDelete={removePage} onReorder={(from, to) => documentChange(reorderDesignPages(doc, from, to))} onImport={importHtml} onError={model.setError}
        panel={doc.pages.length > 1 ? <DesignTransitionControls page={page} pages={doc.pages} slides={doc.kind === "slides"} onChange={transitionChange} onApplyAll={applyTransitionToAll} onPreview={() => setTransitionPreview(true)} /> : undefined} />
      <main className="design-stage">
        <div className="design-stage-toolbar"><div className="design-view-switch" role="group" aria-label="编辑模式"><button type="button" aria-pressed={mode === "visual"} onClick={() => setMode("visual")}>可视编辑</button><button type="button" aria-pressed={mode === "source"} onClick={() => setMode("source")}>HTML 源码</button></div>
          {doc.kind !== "slides" && <label>尺寸<select aria-label="响应式预览尺寸" value={viewport} onChange={event => setViewport(event.target.value as typeof viewport)}>{["desktop", "tablet", "mobile"].map(key => <option key={key} value={key}>{designViewports[key as keyof typeof designViewports].title}</option>)}</select></label>}
          <button type="button" aria-pressed={interactive} onClick={() => { setInteractive(value => !value); setCommentMode(false); setDraft(null); }}>{interactive ? "返回点选" : "运行交互"}</button>
          {doc.kind === "slides" && <button type="button" onClick={() => { setMode("visual"); setPresenting(value => !value); setCommentMode(false); setDraft(null); selection([]); root.current?.focus(); }}>{presenting ? "退出演示" : "播放演示"}</button>}
        </div>
        {draft && <form className="design-annotation-form" onSubmit={event => { event.preventDefault(); saveAnnotation(); }}>
          <span className="g-label">{draft.id ? "编辑批注" : "新批注"} · {Math.round(draft.x)}% / {Math.round(draft.y)}%</span>
          <textarea aria-label="批注内容" autoFocus maxLength={2000} value={draft.text} placeholder="这里想改成什么？例如：标题再大一点，按钮换成主色。" onChange={event => setDraft(current => current ? { ...current, text: event.target.value } : current)} />
          <div className="design-annotation-actions"><button type="submit" className="design-primary" disabled={!draft.text.trim()}>保存批注</button><button type="button" onClick={() => setDraft(null)}>取消</button>{draft.id && <button type="button" onClick={() => removeAnnotation(draft.id!)}>删除</button>}</div>
        </form>}
        {assetOpen && <section className="design-asset-panel" aria-label="插入图片">
          <header><span className="g-label">插入图片</span><span>{selected.length && describeDesignNode(page.html, selected[0]!)?.tagName === "img" ? "将替换选中图片" : "将插入到页面末尾"}</span><button type="button" onClick={closeAssets}>关闭</button></header>
          <div className="design-asset-tools">
            <label className="design-asset-file">从本机选择<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="从本机选择图片" disabled={assetBusy} onChange={event => { void pickFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
            <button type="button" disabled={assetBusy} onClick={() => void refreshAssets()}>{assetBusy ? "读取中…" : "刷新素材库"}</button>
            <span className="design-asset-note">图片内联；大图会生成 512 KiB 内的页面副本，原图保留。支持 8 MiB 内图片，整页最多 1 MiB。</span>
          </div>
          <details open={generateOpen} onToggle={event => { const next = event.currentTarget.open; setGenerateOpen(next); if (next) setGenerateImage(true); }}><summary>在这里生成图片</summary>
            {generateImage && <Suspense fallback={<p role="status">正在加载图片生成…</p>}><QuickImage disabled={assetBusy} onUse={async url => {
              const library = await readLibrary(undefined, true), asset = library.find(item => applicationUrl(item.url) === applicationUrl(url));
              if (!asset) throw new Error("生成图片不在当前素材库，请刷新后重试。");
              await pickLibrary(asset);
            }} /></Suspense>}
          </details>
          {assetError && <p role="alert" className="design-asset-error">{assetError}</p>}
          {projectAssets.length > 0 && <><span className="g-label">本项目用过</span>
            <ul className="design-asset-grid">{projectAssets.slice(0, 12).map(asset => <li key={`own-${asset.name}`}>
              <button type="button" disabled={assetBusy} onClick={() => void pickLibrary(asset)} title={`${asset.name} · ${Math.round(asset.bytes / 1024)} KB`}>
                <img src={applicationUrl(asset.url)} alt="" loading="lazy" /><span>{asset.name}</span>
              </button>
            </li>)}</ul></>}
          {assets.length > 0 && <><span className="g-label">素材库</span>
          <ul className="design-asset-grid">{assets.slice(0, 24).map(asset => <li key={asset.name}>
            <button type="button" disabled={assetBusy} onClick={() => void pickLibrary(asset)} title={`${asset.name} · ${Math.round(asset.bytes / 1024)} KB`}>
              <img src={applicationUrl(asset.url)} alt="" loading="lazy" /><span>{asset.name}</span>
            </button>
          </li>)}</ul></>}
          {!assetBusy && !assetError && assets.length === 0 && <p className="design-asset-note">素材库还没有图片；可先用本机图片，或到素材工坊生成。</p>}
        </section>}
        {!presenting && <div className="design-titles"><label>文档标题<input aria-label="设计文档标题" value={documentTitle} onChange={event => setDocumentTitle(event.target.value)} onBlur={() => { if (documentTitle.trim() && documentTitle !== doc.title) documentChange({ ...doc, title: documentTitle.trim() }); else setDocumentTitle(doc.title); }} /></label><label>页标题<input aria-label="页面标题" value={pageTitle} onChange={event => setPageTitle(event.target.value)} onBlur={() => { if (pageTitle.trim() && pageTitle !== page.title) pageChange({ title: pageTitle.trim() }); else setPageTitle(page.title); }} /></label></div>}
        {pageTransition ? <DesignTransitionPlayer play={pageTransition} interactive onMessage={() => { }} onFinished={commitTransition} brand={brand} /> : mode === "source" ? <textarea ref={source} className="design-source" aria-label="页面 HTML 源码" spellCheck={false} value={page.html} onChange={event => { if (event.target.value.length > DESIGN_HTML_LIMIT) { model.setError("HTML 超过 1 MB，未应用超限修改。"); return; } pageChange({ html: event.target.value }); }} onCompositionStart={() => model.composition(true)} onCompositionEnd={() => model.composition(false)} /> : <DesignPreview pageIds={doc.pages.map(item=>item.id)} inlineText={inlineText && inlineText.documentId===doc.id && inlineText.pageId===page.id ? {...inlineText,onChange:text=>setInlineText(current=>current?{...current,text}:null),onApply:applyInlineText,onCancel:()=>setInlineText(null)} : undefined} html={page.html} viewport={doc.kind === "slides" ? "slides" : viewport} interactive={interactive || presenting} selected={presenting ? [] : selected} commentMode={commentMode} annotations={page.annotations ?? []} brand={brand} stepReveal={presenting && (page.stepReveal ?? false)} onMessage={message} onAnnotation={id => { const mark = (page.annotations ?? []).find(item => item.id === id); if (mark) setDraft({ id: mark.id, x: mark.x, y: mark.y, text: mark.text, nodeId: mark.nodeId }); }} />}
        {presenting ? <div className="design-presentation-controls"><button type="button" onClick={() => movePage(-1)} disabled={doc.pages[0]!.id === page.id} title={doc.pages[0]!.id === page.id ? "已经是第一页" : "上一页"}>上一页</button><span>{doc.pages.findIndex(item => item.id === page.id) + 1} / {doc.pages.length} · {page.title}</span><button type="button" onClick={() => movePage(1)} disabled={doc.pages.at(-1)!.id === page.id} title={doc.pages.at(-1)!.id === page.id ? "已经是最后一页" : "下一页"}>下一页</button><button type="button" onClick={() => setPresenting(false)}>退出演示模式</button></div> : <>
          {(page.annotations?.length ?? 0) > 0 && <section className="design-annotation-list" aria-label="页面批注">
            <header className="design-review-head"><span className="g-label">页面批注 · {page.annotations!.length}</span>
              {onReview && <button type="button" disabled={!reviewIds.length} onClick={reviewAnnotations}>送入助手草稿 · {reviewIds.length}</button>}
            </header>
            <ol>{page.annotations!.map((mark, position) => <li key={mark.id}>{onReview && <input type="checkbox" aria-label={`选入修改批注 ${position + 1}`} checked={reviewIds.includes(mark.id)} disabled={!mark.nodeId || (!reviewIds.includes(mark.id) && reviewIds.length >= 50)} title={!mark.nodeId ? "此批注仅标记位置，请关联元素后再送入助手" : "每次最多选择 50 条批注"} onChange={event => setReviewIds(ids => event.target.checked ? [...new Set([...ids, mark.id])].slice(0, 50) : ids.filter(id => id !== mark.id))} />}<button type="button" onClick={() => setDraft({ id: mark.id, x: mark.x, y: mark.y, text: mark.text, nodeId: mark.nodeId })}><b className="g-num">{position + 1}</b><span>{mark.text}</span></button><button type="button" className="design-annotation-remove" aria-label={`删除批注 ${position + 1}`} onClick={() => removeAnnotation(mark.id)}>×</button></li>)}</ol>
          </section>}
          <p className="design-hint">Ctrl/⌘ S 保存 · 源码与可视操作共用撤销 · Esc 清除选择。交互模式不编辑元素；动态 JS 节点不可回写。外部资源与导航受隔离策略限制。</p>
          {doc.kind === "slides" && <label className="design-notes">演讲备注<textarea aria-label="演讲备注" value={page.notes ?? ""} onChange={event => pageChange({ notes: event.target.value })} onCompositionStart={() => model.composition(true)} onCompositionEnd={() => model.composition(false)} placeholder="记录这一页的讲述要点，演示时隐藏。" /></label>}
        </>}
      </main>
      {inspectorOpen && <DesignInspector pages={doc.pages} projectId={projectId} html={page.html} selected={selected} onSelect={selection} onPatch={patch}
        onMaskEdit={() => { if (selected[0]) setMaskNodeId(selected[0]); }}
        onRegenerate={() => { setAssetOpen(true); setGenerateOpen(true); void refreshAssets(); }} />}
    </div>}
    {maskNodeId && (() => {
      const imageSrc = selectedImageSrc(page.html, maskNodeId);
      if (!imageSrc) { return null; }
      return <Suspense fallback={<p role="status">正在加载局部修改…</p>}><MaskEditor projectId={projectId} imageSrc={imageSrc} onClose={() => setMaskNodeId(null)} onNotice={setNotice}
        onAdopt={dataUrl => {
          try { pageChange({ html: replaceDesignImage(page.html, maskNodeId, dataUrl) }); setMaskNodeId(null); setNotice("已替换为掩膜合成结果 · 可一次撤销，原图仍在素材库。"); }
          catch (error) { model.setError(error instanceof Error ? error.message : "替换失败，页面未修改。"); }
        }} /></Suspense>;
    })()}
    {notice && <p className="design-notice" role="status" aria-live="polite">{notice}</p>}
  </section>;
}
