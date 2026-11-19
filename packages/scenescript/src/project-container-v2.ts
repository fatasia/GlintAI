import { z } from "zod";
import { parsePrevizDocument } from "@glintai/previz";
import { DesignDocument, ScriptDocument } from "./auxiliary-documents";
import {
  canonicalProjectJson,
  parseProjectContainer,
  parseProjectContainerWithDigest,
  projectContentDigest,
  ProjectVersionSchema,
  type ProjectVersion,
} from "./project-container";

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const containerDocumentKinds = [
  "scene-document",
  "timeline-document",
  "script-document",
  "design-document",
  "previz-document",
] as const;
export type ContainerDocumentKind = (typeof containerDocumentKinds)[number];
export const isContainerDocument = (kind: string): kind is ContainerDocumentKind =>
  (containerDocumentKinds as readonly string[]).includes(kind);
const kind = z.enum([
  ...containerDocumentKinds,
  "asset",
  "generation-result",
  "reference-document",
]);
const object = z
  .object({ id: identity, kind, currentVersionId: identity, archived: z.boolean() })
  .strict();
const schema = z
  .object({
    format: z.literal("glint-project"),
    version: z.literal(2),
    id: identity,
    objects: z.array(object).max(10000),
    versions: z.array(ProjectVersionSchema).max(50000),
    migration: z.object({ sourceProjectId: identity, sourceDigest: digest }).strict().optional(),
  })
  .strict();
export type ProjectContainerV2 = Omit<z.infer<typeof schema>, "versions"> & {
  versions: ProjectVersion[];
};
export type UnifiedProjectContainer =
  | Awaited<ReturnType<typeof parseProjectContainer>>
  | ProjectContainerV2;

function structure(input: unknown) {
  const value = schema.parse(JSON.parse(canonicalProjectJson(input)));
  if (!value.objects.some((item) => isContainerDocument(item.kind) && !item.archived))
    throw new Error("At least one active document is required");
  if (value.objects.some((item) => !isContainerDocument(item.kind) && item.archived))
    throw new Error("Only documents can be archived");
  return value;
}
function legacyProjection(value: z.infer<typeof schema>) {
  return {
    format: value.format,
    version: 1,
    id: value.id,
    objects: value.objects.map((item) => ({
      id: item.id,
      currentVersionId: item.currentVersionId,
      kind: ["script-document", "design-document", "previz-document"].includes(item.kind)
        ? "reference-document"
        : item.kind,
    })),
    versions: value.versions.map((version) => {
      const entry = version as ProjectVersion;
      const kind = value.objects.find((item) => item.id === entry?.objectId)?.kind;
      if (!["script-document", "design-document", "previz-document"].includes(kind ?? ""))
        return entry;
      const projected = { ...entry };
      delete projected.archive;
      return projected;
    }),
  };
}
export function parseAuxiliaryDocument(kind: string, input: unknown) {
  if (kind === "script-document") return ScriptDocument.parse(input);
  if (kind === "design-document") return DesignDocument.parse(input);
  if (kind === "previz-document") return parsePrevizDocument(input);
  throw new Error("Unknown auxiliary document kind");
}
function finish(value: z.infer<typeof schema>, versions: ProjectVersion[]): ProjectContainerV2 {
  const ids = new Map<string, string>();
  for (const version of value.versions as ProjectVersion[]) {
    const owner = value.objects.find((item) => item.id === version.objectId)!;
    if (!["script-document", "design-document", "previz-document"].includes(owner.kind)) continue;
    const payload = parseAuxiliaryDocument(owner.kind, version.payload);
    if (canonicalProjectJson(payload) !== canonicalProjectJson(version.payload))
      throw new Error("Document must be normalized before import");
    if (ids.has(owner.id) && ids.get(owner.id) !== payload.id)
      throw new Error("Document identity cannot change within an object");
    ids.set(owner.id, payload.id);
    if (
      version.archive &&
      canonicalProjectJson(parseAuxiliaryDocument(owner.kind, version.archive.original)) !==
        canonicalProjectJson(payload)
    )
      throw new Error("Invalid document migration archive");
  }
  return {
    ...value,
    versions: versions.map((version, index) => ({
      ...version,
      ...(Object.hasOwn(value.versions[index]!, "archive")
        ? { archive: (value.versions[index] as ProjectVersion).archive }
        : {}),
    })),
  };
}
export function parseUnifiedContainerWithDigest(
  input: unknown,
  hash: (payload: unknown) => string,
): UnifiedProjectContainer {
  if ((input as { version?: unknown })?.version !== 2)
    return parseProjectContainerWithDigest(input, hash);
  const value = structure(input);
  return finish(value, parseProjectContainerWithDigest(legacyProjection(value), hash).versions);
}
export async function parseUnifiedContainer(input: unknown): Promise<UnifiedProjectContainer> {
  if ((input as { version?: unknown })?.version !== 2) return parseProjectContainer(input);
  const value = structure(input);
  return finish(value, (await parseProjectContainer(legacyProjection(value))).versions);
}
/** Explicit new copy only. No file or journal is changed by this pure conversion. */
export async function migrateContainerV2(
  input: unknown,
  newId: string,
): Promise<ProjectContainerV2> {
  const source = await parseUnifiedContainer(input);
  identity.parse(newId);
  if (source.id === newId) throw new Error("Migration requires a new project identity");
  return (await parseUnifiedContainer({
    ...source,
    version: 2,
    id: newId,
    objects: source.objects.map((item) => ({
      ...item,
      archived: "archived" in item ? item.archived : false,
    })),
    migration: { sourceProjectId: source.id, sourceDigest: await projectContentDigest(source) },
  })) as ProjectContainerV2;
}
