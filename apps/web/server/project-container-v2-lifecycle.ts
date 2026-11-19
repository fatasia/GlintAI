import { canonicalProjectJson } from "@glintai/scenescript/project-container";
import {
  isContainerDocument,
  type ContainerDocumentKind,
} from "@glintai/scenescript/project-container-v2";
import type { FileSessionStore } from "@glintai/session/node";
import type { EditTransaction } from "@glintai/session";
import { containerPayloadDigest, parseStoredContainer } from "./project-container-session";

export type ContainerLifecycleChange =
  | { action: "archive" | "restore"; objectId: string }
  | {
      action: "add";
      objectId: string;
      versionId: string;
      kind: ContainerDocumentKind;
      payload: unknown;
    };
type Request = Omit<EditTransaction, "projectId" | "operations">;
/** A semantic request is bound before FileSessionStore checks an idempotent retry. */
export function changeContainerLifecycle(
  store: FileSessionStore,
  projectId: string,
  request: Request,
  change: ContainerLifecycleChange,
) {
  const snapshot = JSON.parse(canonicalProjectJson(change)) as ContainerLifecycleChange;
  const bound = {
    ...request,
    intent: `${request.intent}\ncontainer-lifecycle:${containerPayloadDigest(snapshot)}`,
  };
  return store.applyTransform(projectId, bound, (document) => {
    const container = parseStoredContainer(document);
    if (container.version !== 2)
      throw new Error("Migrate to a new v2 copy before changing document lifecycle");
    const objects = structuredClone(container.objects),
      versions = structuredClone(container.versions);
    if (snapshot.action === "add") {
      if (
        !isContainerDocument(snapshot.kind) ||
        objects.some((item) => item.id === snapshot.objectId) ||
        versions.some((item) => item.id === snapshot.versionId)
      )
        throw new Error("Object and version identities must be new");
      objects.push({
        id: snapshot.objectId,
        kind: snapshot.kind,
        currentVersionId: snapshot.versionId,
        archived: false,
      });
      versions.push({
        id: snapshot.versionId,
        objectId: snapshot.objectId,
        payload: snapshot.payload,
        contentDigest: containerPayloadDigest(snapshot.payload),
        actor: request.actor,
        transactionId: request.id,
        sources: [],
        references: [],
      });
    } else {
      const object = objects.find((item) => item.id === snapshot.objectId);
      if (!object || !isContainerDocument(object.kind)) throw new Error("Document does not exist");
      object.archived = snapshot.action === "archive";
    }
    return [
      { kind: "set", path: ["objects"], value: objects },
      { kind: "set", path: ["versions"], value: versions },
    ];
  });
}
