import { readReferenceImage, type ReferenceImage } from "./reference-image";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { artifactDiff, artifactFingerprint, artifactImpact, parseArtifactProject, validateArtifactProposal, type ArtifactDocument, type ArtifactEditRequest, type ArtifactProject, type ArtifactSelection } from "./artifact-project";
import "./artifact-assistant.css";

export type ArtifactAssistantProps = { projectId: string; title: string; document: ArtifactDocument; onApply(document: ArtifactDocument): void | boolean; selection?: ArtifactSelection; draftRequest?: ArtifactEditRequest };
type Message = { id: string; role: "user" | "assistant"; text: string };
type Preview = { base: ArtifactProject; next: ArtifactProject; summary: string; selection?: ArtifactSelection };
const historyKey = (projectId: string, docId: string) => `glint.artifact-assistant.v1:${JSON.stringify([projectId, docId])}`;
const scrub = (text: string) => text.replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]").replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[^\s,;]+)/g, "[已隐藏]");
function readHistory(key: string): Message[] {
  const raw = localStorage.getItem(key); if (!raw) return [];
  if (raw.length > 300000) throw new Error("历史记录过大，请备份后清理本机历史。");
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(item => !item || typeof item.id !== "string" || !["user", "assistant"].includes(item.role) || typeof item.text !== "string")) throw new Error("对话历史无法识别，旧记录未覆盖。");
  return value.slice(-40).map(({ id, role, text }) => ({ id, role, text: scrub(text).slice(0, 6000) }));
}
const message = (role: Message["role"], text: string): Message => ({ id: crypto.randomUUID(), role, text: scrub(text).slice(0, 6000) });
const safePreview = (html: string) => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'">${html}`;

/** API-only executor. Native conversations are owned by the host's LocalAgentChat. */
export function ArtifactAssistant(props: ArtifactAssistantProps) {
  const { projectId, title, document: doc, selection } = props;
  const key = historyKey(projectId, doc.id);
  const [instruction, setInstruction] = useState("");
  const [reference,setReference]=useState<ReferenceImage|null>(null);
  const referenceSequence=useRef(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const latest = useRef(props); latest.current = props;
  const active = useRef<AbortController | null>(null);
  const pending = useRef<Preview | null>(null);
  const history = useRef({ key, messages: [] as Message[], writable: true });
  const envelope = (value: ArtifactAssistantProps): ArtifactProject => ({ schemaVersion: 1, id: value.projectId, title: value.title, document: value.document });
  const add = (role: Message["role"], text: string) => {
    const current = history.current;
    current.messages = [...current.messages, message(role, text)].slice(-40); setMessages(current.messages);
    if (current.writable) try { localStorage.setItem(current.key, JSON.stringify(current.messages)); }
    catch { setStorageError("历史保存失败；当前对话仍保留，请恢复本机存储权限或释放空间。"); }
  };
  useEffect(() => {
    active.current?.abort(); active.current = null; pending.current = null;
    setPhase(""); setPreview(null); setError(""); setStorageError(""); setInstruction("");setReference(null);referenceSequence.current++;
    try { const saved = readHistory(key); history.current = { key, messages: saved, writable: true }; setMessages(saved); }
    catch { history.current = { key, messages: [], writable: false }; setMessages([]); setStorageError("本机历史读取失败或损坏；旧记录未覆盖，当前会话仍可使用。"); }
    return () => { active.current?.abort(); active.current = null; pending.current = null; };
  }, [key]);
  useEffect(() => {
    const request = props.draftRequest;
    if (request?.projectId === projectId && request.documentId === doc.id) setInstruction(request.instruction);
  }, [props.draftRequest?.id, key]);
  const cancel = () => {
    if (!active.current) return;
    active.current.abort(); active.current = null; setPhase(""); setError(""); add("assistant", "已取消，原文档没有修改。");
  };
  const send = async () => {
    if (active.current || !instruction.trim()) return;
    const captured = latest.current, input = instruction, capturedReference=reference;
    let base: ArtifactProject;
    try {
      if (captured.draftRequest && captured.draftRequest.documentFingerprint !== artifactFingerprint(captured.document)) throw new Error("文档已变化，批注请求已过期；请重新选择批注，或取消批注选区约束后编写新要求。");
      base = parseArtifactProject(envelope(captured));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "文档无法识别，未发送请求。"); return; }
    const fingerprint = artifactFingerprint(base);
    const controller = new AbortController(); active.current = controller; pending.current = null;
    setPreview(null); setInstruction(""); setError(""); setPhase("正在生成文档提案，完成后先预览再确认。"); add("user", input);
    const timer = setTimeout(() => {
      if (active.current !== controller) return;
      controller.abort(); active.current = null; setPhase(""); setError("生成超时，原文档未修改；请检查文本模型后重试。");
      add("assistant", "生成超时，原文档未修改；请重试。");
    }, 65000);
    try {
      const response = await fetch("/api/artifact/proposal", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, document: base.document, instruction: input, ...(capturedReference?{referenceImage:{mimeType:capturedReference.mimeType,data:capturedReference.data}}:{}), ...(captured.selection ? { selection: captured.selection } : {}) }), signal: controller.signal });
      if (active.current !== controller || controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 503 ? "请先配置文本模型，再重试生成；原文档未修改。" : response.status === 403 || response.status === 401 ? "文档生成请求未获授权；请从本机受信入口重试。" : response.status === 413 ? "文档过大，请精简内容后重试。" : "生成失败，原文档未修改；请检查模型服务后重试。");
      const raw = await response.text();
      if (active.current !== controller || controller.signal.aborted) return;
      if (raw.length > 2200000) throw new Error("模型返回内容过大，未应用。");
      const data = JSON.parse(raw) as { document?: unknown; summary?: unknown };
      if (typeof data.summary !== "string" || !data.summary.trim() || data.summary.length > 4000) throw new Error("提案说明无效，请重试。");
      const next = validateArtifactProposal(base, { ...base, document: data.document }, captured.selection);
      if (artifactFingerprint(envelope(latest.current)) !== fingerprint) throw new Error("生成期间文档已变化，本次迟到结果未应用；请基于最新文档重新生成。");
      const result = { base, next, summary: data.summary, selection: captured.selection };
      pending.current = result; setPreview(result); add("assistant", `${data.summary}\n提案已生成，请核对差异后确认应用。`);
    } catch (failure) {
      if (active.current !== controller || controller.signal.aborted) return;
      const detail = failure instanceof Error && !(failure instanceof SyntaxError) ? failure.message : "模型返回格式无效，原文档未修改；请重试。";
      setError(detail); add("assistant", detail);
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setPhase(""); } }
  };
  const apply = () => {
    const result = pending.current; if (!result) return;
    pending.current = null; setPreview(null);
    try {
      if (artifactFingerprint(envelope(latest.current)) !== artifactFingerprint(result.base)) throw new Error("预览后文档已变化，提案已失效；请重新生成，不会覆盖新版本。");
      const validated = validateArtifactProposal(result.base, result.next, result.selection);
      if (latest.current.onApply(validated.document) === false) throw new Error("编辑器未接受提案，原文档没有修改。");
      add("assistant", "提案已作为一次修改应用；可使用编辑器一次撤销。"); setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "应用失败，请保留原文档后重试。"); }
  };
  const changes = preview ? artifactDiff(preview.base.document, preview.next.document) : [];
  const impact = preview ? artifactImpact(preview.base.document, preview.next.document, preview.selection) : null;
  return <section className="artifact-assistant" aria-label="文档创作助手" onKeyDown={event => {
    if (event.key === "Escape") { if (active.current) cancel(); else { pending.current = null; setPreview(null); } }
  }}>
    <header><strong>文档创作助手</strong><span>API 文本模型</span></header>
    <p className="artifact-assistant-target">{title} · {doc.title}</p>
    <p className="artifact-assistant-hint">{selection ? "仅修改选区及必要布局，其他原文保留。" : "可从当前要求重新创作当前页面或整份脚本文档。"} 生成后先看差异，不会自动覆盖。</p>
    {messages.length ? <ol aria-label="本文档对话记录" className="artifact-assistant-history">{messages.map(item => <li key={item.id} data-role={item.role}><small>{item.role === "user" ? "你" : "助手"}</small><div>{item.text}</div></li>)}</ol> : <div className="artifact-assistant-empty">描述你想创作的内容、受众与表达方式，或选中文字后要求局部改写。</div>}
    {storageError && <p role="status" className="artifact-assistant-warning">{storageError}</p>}
    {phase && <p role="status" className="artifact-assistant-phase">{phase}</p>}
    {error && <p role="alert" className="artifact-assistant-error">{error}</p>}
    {preview && <section className="artifact-assistant-proposal" aria-label="提案预览">
      <strong>改动影响单</strong><p>{preview.summary}</p>
      {impact && <dl className="artifact-impact" aria-label="改动影响">
        <div><dt>范围</dt><dd>{impact.scope}</dd></div>
        <div><dt>页面</dt><dd>{impact.pages.join("、") || ("content" in doc ? "当前脚本" : "无页面内容变化")}</dd></div>
        <div><dt>对象</dt><dd>{impact.nodeIds.length} 个节点{impact.globalStyle ? " · 含全局样式" : " · 全局样式不变"}</dd></div>
        <div><dt>来源与回退</dt><dd>{impact.origin} · {impact.undo}</dd></div>
        <div><dt>其他内容</dt><dd>其他页面、锁定内容与人工批注已校验保留</dd></div>
        <div><dt>费用 / 时长</dt><dd>{impact.cost} / {impact.duration}</dd></div>
      </dl>}
      {"pages" in preview.next.document && <iframe title="生成页面预览" sandbox="" referrerPolicy="no-referrer" srcDoc={safePreview(preview.next.document.pages.find(page => "pages" in preview.next.document && page.id === preview.next.document.activePageId)?.html ?? "")} />}
      {changes.length ? changes.map((change, index) => <details key={index} open><summary>{change.label}</summary><div className="artifact-assistant-diff"><div><small>修改前</small><pre>{change.before}</pre></div><div><small>修改后</small><pre>{change.after}</pre></div></div></details>) : <p>内容没有变化，无需应用。</p>}
      <div className="artifact-assistant-actions"><button type="button" className="artifact-assistant-primary" disabled={!changes.length} title={!changes.length ? "提案没有内容变化" : "确认后交由编辑器应用一次"} onClick={apply}>确认应用</button><button type="button" onClick={() => { pending.current = null; setPreview(null); }}>放弃提案</button></div>
    </section>}
    {"pages" in doc && <div className="artifact-assistant-reference">
      <label>参考截图（PNG）<input type="file" accept="image/png,.png" aria-label="上传设计参考截图" disabled={!!phase} onChange={async event=>{
        const file=event.target.files?.[0];event.target.value="";if(!file)return;
        const sequence=++referenceSequence.current,capturedKey=key;
        try{const image=await readReferenceImage(file);if(sequence===referenceSequence.current&&history.current.key===capturedKey){setReference(image);setError("");}}
        catch(cause){if(sequence===referenceSequence.current)setError(cause instanceof Error?cause.message:"参考图无法读取。");}
      }}/></label>
      {reference&&<div><img alt="待发送的设计参考图" src={`data:image/png;base64,${reference.data}`} style={{maxWidth:"100%",maxHeight:140,objectFit:"contain"}}/><p>{reference.name} · 发送要求时交给已配置的图像理解模型；截图不写入对话历史。</p><button type="button" disabled={!!phase} onClick={()=>{referenceSequence.current++;setReference(null);}}>移除参考图</button></div>}
    </div>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <label>生成或修改要求<textarea aria-label="文档创作指令" maxLength={32000} value={instruction} placeholder="例如：重写为面向初学者的三幕故事；保留事实，语言更生动" onChange={event => setInstruction(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} /></label>
      <div className="artifact-assistant-actions"><button type="submit" className="artifact-assistant-primary" disabled={!!phase || !instruction.trim()} title={phase ? "请等待完成或取消当前生成" : !instruction.trim() ? "先输入创作要求" : "生成提案，不自动应用"}>生成提案</button>{phase && <button type="button" onClick={cancel}>取消生成</button>}</div>
    </form>
    <small className="artifact-assistant-hint">单次 JSON 响应，不生成图片或调用媒体服务。历史只存在本机，并按项目与文档隔离；不保存凭据。</small>
  </section>;
}
