import { useState } from "react";
import { ArtifactAssistant } from "./ArtifactAssistant";
import { LocalAgentChat } from "./LocalAgentChat";
import { isLocalAgentAvailable } from "./local-agent-client";
import { artifactFingerprint, type ArtifactDocument, type ArtifactEditRequest, type ArtifactProject, type ArtifactSelection } from "./artifact-project";
import type { ChatKind } from "./local-agent-chat-model";
import "./artifact-chat.css";

/**
 * The right-hand conversation for a document workspace (design pages, slides, scripts).
 * It keeps one envelope shape for both executors: a local agent when the desktop host
 * provides one, otherwise the configured text model. Selection always travels with the
 * request so "change this" never needs the user to describe where "this" is.
 */
export function ArtifactChat({ projectId, title, document, selection, onApply, hint, request }: {
  projectId: string;
  title: string;
  document: ArtifactDocument;
  selection?: ArtifactSelection;
  onApply(document: ArtifactDocument): void | boolean;
  request?: ArtifactEditRequest;
  hint?: string;
}) {
  const native = isLocalAgentAvailable();
  const [loadedRequest, setLoadedRequest] = useState<ArtifactEditRequest>();
  const review = loadedRequest?.projectId === projectId && loadedRequest.documentId === document.id ? loadedRequest : undefined;
  const fingerprint = artifactFingerprint(document);
  const queued = request?.projectId === projectId && request.documentId === document.id ? request : undefined;
  const stale = !!queued && queued.documentFingerprint !== fingerprint;
  const reviewStale = !!review && review.documentFingerprint !== fingerprint;
  const target = review?.selection ?? selection;
  const [queueError, setQueueError] = useState("");
  const loadReview = () => {
    if (!queued || queued.documentFingerprint !== artifactFingerprint(document)) { setQueueError("文档已变化，批注请求已过期；请回到当前页面重新选择批注。"); return; }
    setQueueError(""); setLoadedRequest({ ...queued, id: crypto.randomUUID() });
  };
  const guardReview = () => {
    if (reviewStale) throw new Error("文档已变化，批注请求已过期；请重新选择批注，或取消批注选区约束后编写新要求。");
  };
  const [executor, setExecutor] = useState<"local" | "api">(native ? "local" : "api");
  const kind: ChatKind = document.kind === "page" || document.kind === "prototype" || document.kind === "slides" ? "design" : "script";
  const envelope: ArtifactProject = { schemaVersion: 1, id: projectId, title, document };
  return <div className="artifact-chat" data-kind={kind}>
    {native && <label className="local-agent-executor artifact-chat-executor">执行者
      <select aria-label="文档助手执行者" value={executor} onChange={event => setExecutor(event.target.value as "local" | "api")}>
        <option value="local">本地智能体</option>
        <option value="api">API 模型</option>
      </select>
    </label>}
    {queued && <section className="artifact-review-queue" aria-label="批注修改队列"><strong>{queued.annotationIds.length} 条批注待处理</strong>
      <p>{stale ? "文档已变化，这组批注请求已过期；请重新选择后送入助手。" : "先载入要求并核对，再发送；不会自动执行。载入会替换输入框草稿。"}</p>
      <div className="artifact-review-actions"><button type="button" disabled={stale} onClick={loadReview}>载入批注到草稿</button>
      {review && <button type="button" onClick={() => { setLoadedRequest(undefined); setQueueError(""); }}>取消批注选区约束</button>}</div>
      {queueError && <p role="alert">{queueError}</p>}
    </section>}
    {executor === "local" && native
      ? <LocalAgentChat project={envelope} kind={kind} context={target ? { selection: target } : undefined} draftRequest={review ? { id: review.id, text: review.instruction } : undefined} beforeSend={guardReview}
        onApply={next => { if ("document" in next) { guardReview(); return onApply((next as ArtifactProject).document); } return false; }} />
      : <ArtifactAssistant projectId={projectId} title={title} document={document} selection={target} draftRequest={review} onApply={onApply} />}
    {hint && <p className="artifact-chat-hint">{hint}</p>}
  </div>;
}
