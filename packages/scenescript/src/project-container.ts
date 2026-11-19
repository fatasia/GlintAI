import { z } from "zod";
import { LocalAssetPath } from "./assets";
import { parseProject } from "./parse";
import { parseNleProject } from "./nle";

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const kind = z.enum(["scene-document", "timeline-document", "asset", "generation-result", "reference-document"]);
const ref = z.object({ objectId: identity, versionId: identity }).strict();
const objectSchema = z.object({ id: identity, kind, currentVersionId: identity }).strict();
const versionSchema = z.object({
  id: identity, objectId: identity, contentDigest: digest,
  parentVersionId: identity.optional(), sources: z.array(ref).max(1000), references: z.array(ref).max(1000),
  actor: identity, transactionId: identity, payload: z.unknown(),
  archive: z.object({ original: z.unknown(), diagnostics: z.array(z.string().max(2000)).max(10000) }).strict().optional(),
}).strict();
export const ProjectVersionSchema = versionSchema;
const schema = z.object({
  format: z.literal("glint-project"), version: z.literal(1), id: identity,
  objects: z.array(objectSchema).max(10000), versions: z.array(versionSchema).max(50000),
}).strict();
const assetSchema = z.object({
  path: LocalAssetPath, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: digest, verification: z.literal("pending-bytes"),
}).strict();
const generationSchema = z.object({ receiptId: identity, parametersDigest: digest.optional() }).strict();

export type ProjectContainer = z.infer<typeof schema>;
export type ProjectObject = z.infer<typeof objectSchema>;
export type ProjectVersion = z.infer<typeof versionSchema>;
export type ProjectVersionRef = z.infer<typeof ref>;
export type DocumentKind = "scene-document" | "timeline-document";

/** Sorted object keys, preserved array order; reject lossy/non-JSON values before hashing. */
export function canonicalProjectJson(value: unknown, depth = 0): string {
  if (depth > 100) throw new Error("JSON nesting exceeds 100");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || !value) throw new Error("Expected finite JSON values");
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("Sparse or extended arrays are not JSON");
    const items = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("JSON arrays require data entries");
      return canonicalProjectJson(descriptor.value, depth + 1);
    });
    return `[${items.join(",")}]`;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected a plain JSON object");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new Error("Symbol keys are not JSON");
  return `{${(keys as string[]).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON properties must be enumerable data");
    return `${JSON.stringify(key)}:${canonicalProjectJson(descriptor.value, depth + 1)}`;
  }).join(",")}}`;
}

export async function projectContentDigest(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalProjectJson(payload));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function indexed<T extends { id: string }>(entries: T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    if (map.has(entry.id)) throw new Error(`Duplicate ${label} ID: ${entry.id}`);
    map.set(entry.id, entry);
  }
  return map;
}

function checkRelations(container: ProjectContainer) {
  const objects = indexed(container.objects, "object"), versions = indexed(container.versions, "version");
  const requireVersion = (reference: ProjectVersionRef) => {
    const version = versions.get(reference.versionId);
    if (!version || version.objectId !== reference.objectId) throw new Error("Dangling or mismatched version reference");
  };
  for (const object of objects.values()) requireVersion({ objectId: object.id, versionId: object.currentVersionId });
  for (const version of versions.values()) {
    if (!objects.has(version.objectId)) throw new Error("Version has no owning object");
    if (version.parentVersionId) requireVersion({ objectId: version.objectId, versionId: version.parentVersionId });
    for (const reference of [...version.sources, ...version.references]) requireVersion(reference);
  }
  const edges = new Map(container.versions.map(v => [v.id, [
    ...(v.parentVersionId ? [v.parentVersionId] : []), ...v.sources.map(r => r.versionId), ...v.references.map(r => r.versionId),
  ]]));
  const visiting = new Set<string>(), done = new Set<string>();
  for (const version of versions.values()) {
    if (done.has(version.id)) continue;
    const stack = [{ id: version.id, next: 0 }]; visiting.add(version.id);
    while (stack.length) {
      const top = stack[stack.length - 1]!, deps = edges.get(top.id)!;
      if (top.next === deps.length) { visiting.delete(top.id); done.add(top.id); stack.pop(); continue; }
      const dependency = deps[top.next++]!;
      if (visiting.has(dependency)) throw new Error("Version parent/source/reference cycle");
      if (!done.has(dependency)) { visiting.add(dependency); stack.push({ id: dependency, next: 0 }); }
    }
  }
  return objects;
}

function projectDocument(documentKind: DocumentKind, payload: unknown): unknown {
  return documentKind === "scene-document" ? parseProject(payload) : parseNleProject(payload);
}

function validatePayload(object: ProjectObject, version: ProjectVersion) {
  if (!Object.hasOwn(version, "payload")) throw new Error("Version payload is required");
  if (object.kind === "asset") {
    const asset = assetSchema.parse(version.payload);
    if (asset.sha256 !== version.contentDigest) throw new Error("Asset byte digest mismatch");
    if (version.archive) throw new Error("Asset versions cannot contain a document archive");
    return; // Actual bytes, size and path boundary must be verified by the later IO layer.
  }
  if (object.kind === "scene-document" || object.kind === "timeline-document") {
    const projected = projectDocument(object.kind, version.payload);
    if (canonicalProjectJson(projected) !== canonicalProjectJson(version.payload)) throw new Error("Document payload must be normalized; use explicit migration to preserve original JSON");
    if (version.archive) {
      const archivedProjection = projectDocument(object.kind, version.archive.original);
      if (canonicalProjectJson(archivedProjection) !== canonicalProjectJson(version.payload)) throw new Error("Archive does not project to the version document");
    }
  } else {
    if (version.archive) throw new Error("Only document versions may carry migration archives");
    if (object.kind === "generation-result") generationSchema.parse(version.payload);
  }
}

/** Shared structural/payload validation stays private: public readers also verify digests. */
function containerStructure(input: unknown): ProjectContainer {
  const snapshot: unknown = JSON.parse(canonicalProjectJson(input));
  const container = schema.parse(snapshot);
  const objects = checkRelations(container);
  const documentIds = new Map<string, unknown>();
  for (const version of container.versions) {
    const object = objects.get(version.objectId)!;
    validatePayload(object, version);
    if (object.kind === "scene-document" || object.kind === "timeline-document") {
      const documentId = (version.payload as { id: string }).id;
      if (documentIds.has(object.id) && documentIds.get(object.id) !== documentId) throw new Error("Document identity cannot change within an object");
      documentIds.set(object.id, documentId);
    }
  }
  return container;
}

/** Synchronous trusted digest adapter for locked Node session operations. */
export function parseProjectContainerWithDigest(input: unknown, digest: (payload: unknown) => string): ProjectContainer {
  const container = containerStructure(input);
  const assets = new Set(container.objects.filter(object => object.kind === "asset").map(object => object.id));
  for (const version of container.versions) if (!assets.has(version.objectId) && digest(version.payload) !== version.contentDigest) throw new Error("Document content digest mismatch");
  return container;
}

/** Readback validator: returns a detached projection; never trusts non-asset content hashes. */
export async function parseProjectContainer(input: unknown): Promise<ProjectContainer> {
  const container = containerStructure(input);
  const assets = new Set(container.objects.filter(object => object.kind === "asset").map(object => object.id));
  for (const version of container.versions) if (!assets.has(version.objectId) && await projectContentDigest(version.payload) !== version.contentDigest) throw new Error("Document content digest mismatch");
  return container;
}

/** Append-only transition. Storage must still wrap this in the existing session CAS transaction. */
export async function appendProjectVersions(
  input: unknown,
  change: { objects?: ProjectObject[]; versions: ProjectVersion[]; current?: ProjectVersionRef[] },
): Promise<ProjectContainer> {
  const delta = z.object({ objects: z.array(objectSchema).optional(), versions: z.array(versionSchema),
    current: z.array(ref).optional() }).strict().parse(JSON.parse(canonicalProjectJson(change)));
  const container = await parseProjectContainer(input);
  const objectIds = new Set(container.objects.map(o => o.id)), versionIds = new Set(container.versions.map(v => v.id));
  for (const object of delta.objects ?? []) {
    if (objectIds.has(object.id)) throw new Error("Cannot replace or reuse an object ID");
    objectIds.add(object.id); container.objects.push(object);
  }
  for (const version of delta.versions) {
    if (versionIds.has(version.id)) throw new Error("Cannot overwrite an immutable version");
    if (version.parentVersionId && !versionIds.has(version.parentVersionId)) throw new Error("Parent version must already exist");
    versionIds.add(version.id); container.versions.push(version);
  }
  const changed = new Set<string>();
  for (const reference of delta.current ?? []) {
    ref.parse(reference);
    if (changed.has(reference.objectId)) throw new Error("Duplicate current pointer change");
    changed.add(reference.objectId);
    const object = container.objects.find(o => o.id === reference.objectId);
    if (!object) throw new Error("Current pointer has no owning object");
    object.currentVersionId = reference.versionId;
  }
  return parseProjectContainer(container);
}

function omittedPaths(original: unknown, projected: unknown, prefix = "$", result: string[] = []): string[] {
  if (!original || typeof original !== "object") return result;
  for (const [key, value] of Object.entries(original)) {
    const location = `${prefix}.${key}`;
    if (!projected || typeof projected !== "object" || !Object.hasOwn(projected, key)) result.push(`Archived unsupported field: ${location}`);
    else omittedPaths(value, (projected as Record<string, unknown>)[key], location, result);
  }
  return result;
}

/** Caller supplies an explicit format tag and new container identity; no heuristic conversion. */
export async function migrateDocumentToContainer(
  input: unknown,
  options: { kind: DocumentKind; projectId: string; objectId: string; versionId: string; actor: string; transactionId: string },
): Promise<{ container: ProjectContainer; diagnostics: string[] }> {
  const opts = z.object({ kind: z.enum(["scene-document", "timeline-document"]), projectId: identity,
    objectId: identity, versionId: identity, actor: identity, transactionId: identity }).strict().parse(options);
  const original: unknown = JSON.parse(canonicalProjectJson(input));
  if (!original || typeof original !== "object" || (original as Record<string, unknown>).schemaVersion !== 1) {
    throw new Error("Explicit migration requires a current schemaVersion 1 document; historical migration must run separately");
  }
  const payload = projectDocument(opts.kind, original);
  const diagnostics = omittedPaths(original, payload);
  const container = await parseProjectContainer({ format: "glint-project", version: 1, id: opts.projectId,
    objects: [{ id: opts.objectId, kind: opts.kind, currentVersionId: opts.versionId }],
    versions: [{ id: opts.versionId, objectId: opts.objectId, contentDigest: await projectContentDigest(payload),
      sources: [], references: [], actor: opts.actor, transactionId: opts.transactionId, payload,
      archive: { original, diagnostics } }],
  });
  return { container, diagnostics: [...diagnostics] };
}

/** Compose explicitly tagged documents into one new container without converting their payloads. */
export async function migrateDocumentsToContainer(
  documents: readonly { kind: DocumentKind; input: unknown; objectId: string; versionId: string }[],
  options: { projectId: string; actor: string; transactionId: string },
): Promise<{ container: ProjectContainer; diagnostics: string[] }> {
  const opts = z.object({ projectId: identity, actor: identity, transactionId: identity }).strict().parse(options);
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 100) throw new Error("Expected 1..100 documents");
  // Detach the whole batch before the first async digest, not one document at a time.
  const entries = z.array(z.object({ kind: z.enum(["scene-document", "timeline-document"]), input: z.unknown(),
    objectId: identity, versionId: identity }).strict()).min(1).max(100).parse(JSON.parse(canonicalProjectJson(documents)));
  indexed(entries.map(entry => ({ id: entry.objectId })), "object");
  indexed(entries.map(entry => ({ id: entry.versionId })), "version");
  const combined: ProjectContainer = { format: "glint-project", version: 1, id: opts.projectId, objects: [], versions: [] };
  const diagnostics: string[] = [];
  for (const { input, ...entry } of entries) {
    const result = await migrateDocumentToContainer(input, { ...opts, ...entry });
    combined.objects.push(...result.container.objects);
    combined.versions.push(...result.container.versions);
    diagnostics.push(...result.diagnostics.map(message => `[${entry.objectId}] ${message}`));
  }
  return { container: await parseProjectContainer(combined), diagnostics };
}
