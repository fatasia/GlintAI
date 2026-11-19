import { serviceTarget, serviceJson, ServiceRequestError } from "./service-http";
import { createHash } from "node:crypto";
import { canonicalJson, ProjectSession, type SessionSnapshot, type SessionLook, type TaskReceipt } from "@glintai/session";
import { parseUnifiedContainer, type UnifiedProjectContainer } from "@glintai/scenescript/project-container-v2";

export type ContainerAction = "snapshot" | "open" | "append" | "undo" | "redo" | "lifecycle" | "migrate-copy";
export type ContainerApiResult = { snapshot: SessionSnapshot<UnifiedProjectContainer>; look: SessionLook; receipt?: TaskReceipt; conflict?: boolean };
export type ContainerRequestOptions = { endpoint: string; token?: string; signal?: AbortSignal };
export const CONTAINER_REQUEST_LIMIT = 16 * 1024 * 1024;
export const CONTAINER_RESPONSE_LIMIT = 32 * 1024 * 1024;
export class ContainerRequestError extends Error {
  constructor(public code: string, public status?: number, public result?: ContainerApiResult) { super(`Container request ${code}`); this.name = "ContainerRequestError"; }
}
const fail = (code: string): never => { throw new ContainerRequestError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-object");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return fail("invalid-identity");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("invalid-revision");
  return value;
}
function containerTarget(endpoint: string, route: string): URL {
  try {
    return serviceTarget(endpoint, route);
  } catch (error) {
    return fail(error instanceof ServiceRequestError ? error.code : "invalid-endpoint");
  }
}
async function verify(value: unknown, projectId: string, transactionId?: string, baseRevision?: number): Promise<ContainerApiResult> {
  const result = object(value), snapshot = object(result.snapshot), look = object(result.look);
  if (snapshot.projectId !== projectId || look.projectId !== projectId || revision(snapshot.revision) !== look.revision || typeof snapshot.digest !== "string" || look.digest !== snapshot.digest) return fail("response-identity-mismatch");
  revision(look.undoDepth); revision(look.redoDepth);
  let document: UnifiedProjectContainer;
  try { document = await parseUnifiedContainer(snapshot.document); } catch { return fail("invalid-container-response"); }
  if (document.id !== projectId) return fail("response-identity-mismatch");
  if (new ProjectSession(projectId, snapshot.document as UnifiedProjectContainer).snapshot().digest !== snapshot.digest) return fail("snapshot-digest-mismatch");
  if (transactionId) {
    const receipt = object(result.receipt);
    if (receipt.projectId !== projectId || receipt.transactionId !== transactionId || receipt.baseRevision !== baseRevision) return fail("receipt-identity-mismatch");
    if (!["verified", "refused"].includes(String(receipt.stage))) return fail("unverified-receipt");
    if (receipt.stage === "verified") {
      const sha = createHash("sha256").update(canonicalJson(snapshot.document)).digest("hex");
      if (receipt.revision !== snapshot.revision || receipt.digest !== snapshot.digest || receipt.documentSha256 !== sha || receipt.verification !== "document-readback") return fail("receipt-proof-mismatch");
    }
  }
  return result as unknown as ContainerApiResult;
}

/** One bounded request. A caller must decide whether to retry using the same transaction. */
export async function containerRequest(
  action: ContainerAction,
  body: Record<string, unknown>,
  options: ContainerRequestOptions,
): Promise<ContainerApiResult> {
  if (!["snapshot", "open", "append", "undo", "redo", "lifecycle", "migrate-copy"].includes(action))
    return fail("invalid-action");
  object(body);
  const projectId = identity(body.projectId),
    url = containerTarget(options.endpoint, `/api/project-containers/${action}`);
  let transactionId: string | undefined, baseRevision: number | undefined;
  if ((action === "append" || action === "lifecycle") || action === "undo" || action === "redo") {
    const tx = (action === "append" || action === "lifecycle") ? object(body.transaction) : body;
    transactionId = identity((action === "append" || action === "lifecycle") ? tx.id : tx.transactionId); baseRevision = revision(tx.baseRevision);
  }
  if (action === "snapshot" && Object.keys(body).some(key => key !== "projectId")) return fail("invalid-snapshot-request");
  let json: string;
  try { json = JSON.stringify(body); } catch { return fail("invalid-json"); }
  if (Buffer.byteLength(json) > CONTAINER_REQUEST_LIMIT) return fail("request-too-large");
  if (action === "snapshot") url.searchParams.set("projectId", projectId);
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  try {
    signal.throwIfAborted();
    const response = await serviceJson(
      url,
      { ...options, signal },
      {
        method: action === "snapshot" ? "GET" : "POST",
        body: action === "snapshot" ? undefined : json,
      },
      CONTAINER_RESPONSE_LIMIT,
    );
    const value = response.value;
    signal.throwIfAborted();
    if (!response.ok && !object(value).snapshot)
      throw new ContainerRequestError("http-refused", response.status);
    const result = await verify(value, projectId, transactionId, baseRevision);
    signal.throwIfAborted();
    if (!response.ok || result.receipt?.stage === "refused" || result.conflict)
      throw new ContainerRequestError("refused", response.status, result);
    return result;
  } catch (error) {
    if (error instanceof ContainerRequestError) throw error;
    if (error instanceof ServiceRequestError)
      throw new ContainerRequestError(error.code, error.status);
    throw new ContainerRequestError(signal.aborted ? "aborted" : "transport-failed");
  }
}

export type ContainerListRow = { projectId: string; revision: number; title: string; sceneCount: number; timelineCount: number; firstDocumentId?: string };
export type ContainerListResult = { projects: ContainerListRow[]; nextCursor: string | null };
/** Metadata only; use snapshot for the selected work, never infer document payloads from this list. */
export async function listContainers(options: ContainerRequestOptions & { limit?: number; cursor?: string }): Promise<ContainerListResult> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || options.limit === null)
    return fail("invalid-limit");
  const cursor = options.cursor === undefined ? undefined : identity(options.cursor),
    url = containerTarget(options.endpoint, "/api/project-containers/list");
  url.searchParams.set("limit", String(limit));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    const response = await serviceJson(
      url,
      { ...options, signal },
      { method: "GET" },
      CONTAINER_RESPONSE_LIMIT,
    );
    const value = object(response.value);
    signal.throwIfAborted();
    if (!response.ok) throw new ContainerRequestError("http-refused", response.status);
    if (Object.keys(value).some(key => !["projects", "nextCursor"].includes(key)) || !Array.isArray(value.projects) || value.projects.length > limit) return fail("invalid-list-response");
    let previous = cursor ?? "";
    const projects = value.projects.map(raw => {
      const row = object(raw), projectId = identity(row.projectId);
      if (Object.keys(row).some(key => !["projectId", "revision", "title", "sceneCount", "timelineCount", "firstDocumentId"].includes(key)) || projectId <= previous || typeof row.title !== "string" || [...row.title].length > 160) return fail("invalid-list-response");
      previous = projectId;
      return { projectId, revision: revision(row.revision), title: row.title, sceneCount: revision(row.sceneCount), timelineCount: revision(row.timelineCount),
        ...(row.firstDocumentId === undefined ? {} : { firstDocumentId: identity(row.firstDocumentId) }) };
    });
    const nextCursor = value.nextCursor === null ? null : identity(value.nextCursor);
    if (nextCursor !== null && (!projects.length || nextCursor !== previous)) return fail("invalid-list-cursor");
    return { projects, nextCursor };
  } catch (error) {
    if (error instanceof ContainerRequestError) throw error;
    if (error instanceof ServiceRequestError)
      throw new ContainerRequestError(error.code, error.status);
    throw new ContainerRequestError(signal.aborted ? "aborted" : "transport-failed");
  }
}
