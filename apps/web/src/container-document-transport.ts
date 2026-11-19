import { appFetch } from "./app-url";
import { canonicalJson, type EditTransaction } from "@glintai/session";
import { parseUnifiedContainer, isContainerDocument, type UnifiedProjectContainer } from "@glintai/scenescript/project-container-v2";
import type { DocumentSessionTransport, SessionDocument } from "./session-client";

export type ContainerDocumentBinding = { projectId: string; objectId: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** Initial read before creating the existing session client; never creates a container. */
export async function loadContainerDocument<T>(binding: ContainerDocumentBinding, parse: (value: unknown) => T, transport: Fetch = appFetch): Promise<T> {
  const result = await transport(`/api/project-containers/snapshot?projectId=${encodeURIComponent(binding.projectId)}`);
  if (!result.ok) throw new Error("Shared document could not be opened");
  const value = await result.json();
  const raw = value.snapshot?.document;
  const container = raw?.version === 2 ? await parseUnifiedContainer(raw) : raw as UnifiedProjectContainer;
  if (container?.format !== "glint-project" || ![1, 2].includes(container.version) || container.id !== binding.projectId || value.snapshot.projectId !== binding.projectId) throw new Error("Container identity mismatch");
  const object = container.objects.find(item => item.id === binding.objectId);
  const version = object && container.versions.find(item => item.id === object.currentVersionId && item.objectId === object.id);
  if (!version || !object || !isContainerDocument(object.kind) || ("archived" in object && object.archived)) throw new Error("Container document unavailable");
  return parse(version.payload);
}

/** Adapt container projections to the existing session state machine, not a second client. */
export function createContainerDocumentTransport<T extends SessionDocument>(
  binding: ContainerDocumentBinding, parse: (value: unknown) => T, transport: Fetch = appFetch,
): DocumentSessionTransport<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.projectId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.objectId)) throw new Error("Invalid container binding");
  const { projectId, objectId } = binding;
  return async (action, body, submittedDraft) => {
    let result: Response;
    if (action === "snapshot" || action === "open") {
      result = await transport(`/api/project-containers/snapshot?projectId=${encodeURIComponent(projectId)}`);
    } else if (action === "apply") {
      const transaction = body?.transaction as EditTransaction | undefined;
      if (!transaction || !Array.isArray(transaction.operations) || transaction.operations.some(operation => operation.path[0] === "frozen" || operation.path[0] === "assets")) return response({ error: "This container binding cannot change approvals or freeze state" }, 400);
      const { id, baseRevision, actor, scope, intent } = transaction;
      result = await transport("/api/project-containers/append", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId,
        transaction: { id, baseRevision, actor, scope, intent }, changes: [{ objectId, versionId: `version-${id}`, payload: parse(submittedDraft) }] }) });
    } else if (action === "undo" || action === "redo") {
      result = await transport(`/api/project-containers/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, projectId }) });
    } else return response({ error: "This operation is not connected to the container session" }, 400);
    const value = await result.json();
    if (!value.snapshot) return response(value, result.status);
    const raw = value.snapshot.document;
    const container = raw?.version === 2 ? await parseUnifiedContainer(raw) : raw as UnifiedProjectContainer;
    if (container?.format !== "glint-project" || ![1, 2].includes(container.version) || container.id !== projectId || value.snapshot.projectId !== projectId || value.look?.projectId !== projectId || value.look.revision !== value.snapshot.revision) throw new Error("Container snapshot identity or revision mismatch");
    const object = container.objects.find(item => item.id === objectId);
    if (!object || !isContainerDocument(object.kind) || ("archived" in object && object.archived)) throw new Error("Container document is unavailable");
    const version = container.versions.find(item => item.id === object.currentVersionId && item.objectId === objectId);
    if (!version) throw new Error("Container document version is unavailable");
    const document = parse(version.payload);
    if (document.id !== submittedDraft.id) throw new Error("Container document identity changed");
    const expectedId = action === "apply" ? (body?.transaction as EditTransaction).id : body?.transactionId;
    if (result.ok && expectedId && value.receipt?.transactionId !== expectedId) throw new Error("Container receipt does not match the submitted transaction");
    return response({ ...value, snapshot: { ...value.snapshot, document },
      ...(action === "open" && canonicalJson(document) !== canonicalJson(submittedDraft) ? { conflict: true } : {}) }, result.status);
  };
}
