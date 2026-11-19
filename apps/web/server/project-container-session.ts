import { createHash } from "node:crypto";
import { FileSessionStore } from "@glintai/session/node";
import type { EditTransaction } from "@glintai/session";
import { canonicalProjectJson, parseProjectContainerWithDigest, type ProjectContainer, type ProjectVersion } from "@glintai/scenescript/project-container";
import { isContainerDocument, parseUnifiedContainerWithDigest, type ProjectContainerV2 } from "@glintai/scenescript/project-container-v2";
import { transitionContainerV2 } from "./project-container-v2-transition";

const equal = (a: unknown, b: unknown) => canonicalProjectJson(a) === canonicalProjectJson(b);
export const containerPayloadDigest = (payload: unknown) => createHash("sha256").update(canonicalProjectJson(payload)).digest("hex");
const parse = (input: unknown) => parseProjectContainerWithDigest(input, containerPayloadDigest);
const isDocument = (kind: string) => kind === "scene-document" || kind === "timeline-document";
type Payload = { frozen?: boolean; assets?: Array<Record<string, unknown>> };
const approved = (payload: unknown) => ((payload as Payload).assets ?? []).filter(asset => ["character", "product"].includes(String(asset.kind)) && asset.approval);

function guardDocument(before: unknown | undefined, after: unknown) {
  if (before !== undefined && (before as Payload).frozen && !equal(before, after)) throw new Error("Frozen container document cannot be changed; unfreeze is not supported here");
  const old = before === undefined ? [] : approved(before), next = approved(after);
  for (const asset of old) {
    const replacement = ((after as Payload).assets ?? []).filter(item => item.id === asset.id);
    if (replacement.length !== 1 || !equal(asset, replacement[0])) throw new Error("Approved container asset cannot change or lose approval");
  }
  if (next.some(asset => !old.some(previous => equal(previous, asset)))) throw new Error("New container approvals require a trusted endpoint; not supported here");
}

/** Policy is a constructor capability, not an operation or request field. */
const legacyTransition: NonNullable<ConstructorParameters<typeof FileSessionStore>[3]> = (before, candidate, context) => {
  if (!before) {
    const imported = parse(candidate);
    for (const object of imported.objects.filter(object => isDocument(object.kind))) {
      for (const version of imported.versions.filter(version => version.objectId === object.id)) guardDocument(undefined, version.payload);
    }
    return imported;
  }
  const previous = parse(before), raw = candidate as unknown as ProjectContainer;
  if (!Array.isArray(raw.versions) || !Array.isArray(raw.objects)) throw new Error("Container objects and versions are required");
  const retained = new Map(previous.versions.map(version => [version.id, version]));
  const incoming = new Map<string, ProjectVersion>();
  for (const version of raw.versions) {
    if (incoming.has(version.id)) throw new Error("Duplicate immutable version ID");
    incoming.set(version.id, version);
    if (retained.has(version.id) && !equal(retained.get(version.id), version)) throw new Error("Cannot overwrite an immutable version");
  }
  const history = context.action === "undo" || context.action === "redo";
  if (!history && previous.versions.some((version, index) => !raw.versions[index] || !equal(version, raw.versions[index]))) throw new Error("Cannot delete or reorder immutable versions");
  if (history && raw.versions.some(version => !retained.has(version.id))) throw new Error("History cannot invent versions");
  if (history) raw.versions = previous.versions;
  const next = parse(raw);
  if (next.id !== previous.id || next.objects.length !== previous.objects.length || next.objects.some((object, i) => object.id !== previous.objects[i]!.id || object.kind !== previous.objects[i]!.kind)) throw new Error("Container object creation/deletion/identity changes are not supported");
  for (const object of next.objects) {
    const prior = previous.objects.find(item => item.id === object.id)!;
    if (!isDocument(object.kind)) {
      if (!equal(object, prior) || next.versions.some(version => version.objectId === object.id && !retained.has(version.id))) throw new Error("Only existing document objects can be edited");
      continue;
    }
    const oldPayload = retained.get(prior.currentVersionId)!.payload;
    guardDocument(oldPayload, next.versions.find(version => version.id === object.currentVersionId)!.payload);
    const added = next.versions.filter(item => item.objectId === object.id && !retained.has(item.id));
    if (added.length > 1 || added.length === 1 && object.currentVersionId !== added[0]!.id) throw new Error("New document version and current pointer must be committed together");
    for (const version of added) {
      if (context.action !== "edit" || version.parentVersionId !== prior.currentVersionId || version.actor !== context.transaction?.actor || version.transactionId !== context.transaction?.id) throw new Error("New version must identify the current parent and committing transaction");
      guardDocument(oldPayload, version.payload);
    }
  }
  return next;
};

export const parseStoredContainer = (input: unknown) => parseUnifiedContainerWithDigest(input, containerPayloadDigest);
const containerTransition: NonNullable<ConstructorParameters<typeof FileSessionStore>[3]> = (before, candidate, context) => {
  if (candidate.version !== 2 && before?.version !== 2) return legacyTransition(before, candidate, context);
  if (!before) {
    const imported = parseStoredContainer(candidate);
    for (const object of imported.objects.filter(object => isContainerDocument(object.kind)))
      for (const version of imported.versions.filter(version => version.objectId === object.id)) {
        if ((version.payload as Payload).frozen === true) throw new Error("Imported v2 documents cannot inherit frozen state; freezes are established inside this work only");
        guardDocument(undefined, version.payload);
      }
    return imported;
  }
  if (before.version !== 2 || candidate.version !== 2) throw new Error("Use explicit new-copy migration; in-place format changes are forbidden");
  return transitionContainerV2(parseStoredContainer(before) as ProjectContainerV2, candidate as unknown as ProjectContainerV2,
    context, value => parseStoredContainer(value) as ProjectContainerV2, guardDocument);
};

/** Same journal, writer lock, CAS and projection recovery as every existing session. */
export function createProjectContainerStore(directory?: string, afterCommit?: () => void) {
  return new FileSessionStore(directory, document => { parseStoredContainer(document); }, afterCommit, containerTransition);
}

export interface ContainerDocumentChange { objectId: string; versionId: string; payload: unknown }
type Request = Omit<EditTransaction, "projectId" | "operations">;

/** All document versions and current pointers enter one existing session transaction. */
export function appendContainerDocuments(store: FileSessionStore, projectId: string, request: Request, changes: ContainerDocumentChange[]) {
  if (!changes.length || new Set(changes.map(change => change.objectId)).size !== changes.length) throw new Error("Provide one change per existing document object");
  const snapshot = JSON.parse(canonicalProjectJson(changes)) as ContainerDocumentChange[];
  // applyTransform retries bypass its callback; bind the semantic payload to the stored request.
  const bound = { ...request, intent: `${request.intent}\ncontainer-change:${containerPayloadDigest(snapshot)}` };
  return store.applyTransform(projectId, bound, document => {
    const container = parseStoredContainer(document), objects = structuredClone(container.objects), versions = structuredClone(container.versions);
    for (const change of snapshot) {
      const object = objects.find(item => item.id === change.objectId);
      if (!object || !isContainerDocument(object.kind) || ("archived" in object && object.archived)) throw new Error("Only active document objects can be edited");
      if (versions.some(version => version.id === change.versionId)) throw new Error("Cannot reuse immutable version ID");
      const parent = versions.find(version => version.id === object.currentVersionId)!;
      versions.push({ id: change.versionId, objectId: object.id, parentVersionId: object.currentVersionId, payload: change.payload,
        contentDigest: containerPayloadDigest(change.payload), actor: request.actor, transactionId: request.id, sources: parent.sources, references: parent.references });
      object.currentVersionId = change.versionId;
    }
    return [{ kind: "set", path: ["versions"], value: versions }, { kind: "set", path: ["objects"], value: objects }];
  });
}
