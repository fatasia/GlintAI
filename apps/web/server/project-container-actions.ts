import type { EditTransaction, SessionActor } from "@glintai/session";
import type { FileSessionStore } from "@glintai/session/node";
import { migrateContainerV2, isContainerDocument } from "@glintai/scenescript/project-container-v2";
import { appendContainerDocuments } from "./project-container-session";
import { changeContainerLifecycle } from "./project-container-v2-lifecycle";

export function containerRequestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function containerRequestExact(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown request field");
}
export function containerRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("Invalid identity");
  return value;
}
function actor(value: unknown): SessionActor {
  if (!["user", "product-agent", "skill", "cli"].includes(String(value)))
    throw new Error("Invalid actor");
  return value as SessionActor;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid revision");
  return value;
}
function transaction(input: unknown) {
  const tx = containerRequestObject(input);
  containerRequestExact(tx, ["id", "baseRevision", "actor", "scope", "intent", "preconditions"]);
  if (typeof tx.intent !== "string" || tx.intent.length > 2000) throw new Error("Invalid intent");
  return {
    ...tx,
    id: containerRequestId(tx.id),
    baseRevision: revision(tx.baseRevision),
    actor: actor(tx.actor),
    scope: containerRequestObject(tx.scope),
    intent: tx.intent,
  } as Omit<EditTransaction, "projectId" | "operations">;
}
function lifecycle(
  store: () => FileSessionStore,
  projectId: string,
  body: Record<string, unknown>,
) {
  containerRequestExact(body, ["projectId", "transaction", "change"]);
  const change = containerRequestObject(body.change),
    objectId = containerRequestId(change.objectId);
  if (change.action === "add") {
    containerRequestExact(change, ["action", "objectId", "versionId", "kind", "payload"]);
    if (typeof change.kind !== "string" || !isContainerDocument(change.kind))
      throw new Error("Invalid document kind");
    return changeContainerLifecycle(store(), projectId, transaction(body.transaction), {
      action: "add",
      objectId,
      versionId: containerRequestId(change.versionId),
      kind: change.kind,
      payload: change.payload,
    });
  }
  containerRequestExact(change, ["action", "objectId"]);
  if (change.action !== "archive" && change.action !== "restore")
    throw new Error("Invalid lifecycle action");
  return changeContainerLifecycle(store(), projectId, transaction(body.transaction), {
    action: change.action,
    objectId,
  });
}
export async function dispatchContainerAction(
  store: () => FileSessionStore,
  action: string,
  body: Record<string, unknown>,
) {
  const projectId = containerRequestId(body.projectId);
  if (action === "lifecycle") return lifecycle(store, projectId, body);
  if (action === "migrate-copy") {
    containerRequestExact(body, ["projectId", "sourceProjectId"]);
    const source = store().snapshot(containerRequestId(body.sourceProjectId));
    const copy = await migrateContainerV2(source.snapshot.document, projectId);
    return store().open(projectId, copy, undefined, true);
  }
  if (action === "open") {
    containerRequestExact(body, ["projectId", "project", "createOnly"]);
    if (body.createOnly !== undefined && typeof body.createOnly !== "boolean")
      throw new Error("Invalid createOnly");
    const project = containerRequestObject(body.project);
    if (project.id !== projectId) throw new Error("Project identity mismatch");
    return store().open(projectId, project, undefined, body.createOnly === true);
  }
  if (action === "append") {
    containerRequestExact(body, ["projectId", "transaction", "changes"]);
    if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 100)
      throw new Error("Expected 1..100 document changes");
    return appendContainerDocuments(
      store(),
      projectId,
      transaction(body.transaction),
      body.changes.map((value) => {
        const change = containerRequestObject(value);
        containerRequestExact(change, ["objectId", "versionId", "payload"]);
        return {
          objectId: containerRequestId(change.objectId),
          versionId: containerRequestId(change.versionId),
          payload: change.payload,
        };
      }),
    );
  }
  if (action !== "undo" && action !== "redo") throw new Error("Invalid history action");
  containerRequestExact(body, ["projectId", "transactionId", "baseRevision", "actor"]);
  return store().historyEdit(
    projectId,
    action,
    containerRequestId(body.transactionId),
    revision(body.baseRevision),
    actor(body.actor),
  );
}
