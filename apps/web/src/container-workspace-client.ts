import { parseUnifiedContainer, type UnifiedProjectContainer } from "@glintai/scenescript/project-container-v2";
import { migrateDocumentToContainer, migrateDocumentsToContainer, type DocumentKind } from "@glintai/scenescript/project-container";
import type { SessionLook } from "@glintai/session";
import { appFetch } from "./app-url";
import { t } from "./ui/i18n";

type Transport = typeof appFetch;
export type ContainerSnapshot = { container: UnifiedProjectContainer; look: SessionLook };

export async function readContainerReply(response: Response): Promise<ContainerSnapshot> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? t("container.invalid"));
  const container = await parseUnifiedContainer(value.snapshot?.document);
  if (value.snapshot.projectId !== container.id || !value.look || value.look.projectId !== container.id || !Number.isSafeInteger(value.look.revision) || value.look.revision < 0 || value.look.revision !== value.snapshot.revision) throw new Error(t("container.invalid"));
  return { container, look: value.look };
}

export async function readContainer(projectId: string, signal?: AbortSignal, transport: Transport = appFetch) {
  const reply = await readContainerReply(await transport(`/api/project-containers/snapshot?projectId=${encodeURIComponent(projectId)}`, { signal }));
  if (reply.container.id !== projectId) throw new Error(t("container.invalid"));
  return reply;
}

/** Check before projection/migration, including archived originals: never strip an approval. */
export function assertContainerImportable(value: unknown): void {
  const visit = (item: unknown, depth: number) => {
    if (depth > 100) throw new Error(t("container.invalid"));
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if ((key === "approval" && child != null) || (key === "frozen" && child === true)) throw new Error(t("container.approved"));
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

export async function importContainerCopy(input: unknown, kind: DocumentKind | "container", transport: Transport = appFetch): Promise<ContainerSnapshot> {
  assertContainerImportable(input);
  const projectId = `work-${crypto.randomUUID()}`;
  const project = kind === "container" ? { ...await parseUnifiedContainer(input), id: projectId }
    : (await migrateDocumentToContainer(input, { kind, projectId, objectId: `document-${crypto.randomUUID()}`,
      versionId: `import-${crypto.randomUUID()}`, actor: "user", transactionId: `import-${crypto.randomUUID()}` })).container;
  return openNewContainer(project, transport);
}

/** Explicitly pair two source documents; never create intermediate projects or copy media. */
export async function importContainerPair(scene: unknown, timeline: unknown, transport: Transport = appFetch, signal?: AbortSignal): Promise<ContainerSnapshot> {
  assertContainerImportable(scene); assertContainerImportable(timeline);
  const { container } = await migrateDocumentsToContainer([
    { kind: "scene-document", input: scene, objectId: `document-${crypto.randomUUID()}`, versionId: `import-${crypto.randomUUID()}` },
    { kind: "timeline-document", input: timeline, objectId: `document-${crypto.randomUUID()}`, versionId: `import-${crypto.randomUUID()}` },
  ], { projectId: `work-${crypto.randomUUID()}`, actor: "user", transactionId: `import-${crypto.randomUUID()}` });
  return openNewContainer(container, transport, signal);
}

async function openNewContainer(project: UnifiedProjectContainer, transport: Transport, signal?: AbortSignal): Promise<ContainerSnapshot> {
  signal?.throwIfAborted();
  const projectId = project.id;
  const reply = await readContainerReply(await transport("/api/project-containers/open", { ...(signal ? { signal } : {}), method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, project, createOnly: true }) }));
  if (reply.container.id !== projectId) throw new Error(t("container.invalid"));
  return reply;
}

export type PlanPreviewIntent = { objectIds?: string[]; sceneIds?: string[] };
export type PlanPreviewReply = {
  version: 1;
  projectId: string;
  revision: number;
  scope: "all" | "intent";
  impact: {
    totalNodes: number;
    predicted: string[];
    reusedCount: number;
    estimatedMs: number;
    costCny: number;
    costType: "local-free" | "quote-required";
    quoteRequired: { nodeId: string; sceneId: string }[];
    affectedObjects: string[];
  };
  timelineExports: { objectId: string; clips: number; durationMs: number }[];
  unmappedIntents: string[];
  notes: string[];
};

const integer = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;

/** K-03 read-only impact preview; a malformed reply is refused, never guessed. */
export async function previewContainerPlan(projectId: string, intent: PlanPreviewIntent | undefined, signal?: AbortSignal, transport: Transport = appFetch): Promise<PlanPreviewReply> {
  const invalid = () => new Error(t("planPreview.unavailable"));
  const response = await transport("/api/project/plan-preview", {
    ...(signal ? { signal } : {}),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, ...(intent ? { intent } : {}) }),
  });
  let value: unknown;
  try { value = await response.json(); } catch { throw invalid(); }
  if (!response.ok) throw new Error((value as { error?: string })?.error ?? invalid().message);
  const reply = value as PlanPreviewReply;
  if (reply?.version !== 1 || reply.projectId !== projectId || !integer(reply.revision)
    || !["all", "intent"].includes(reply.scope) || !reply.impact
    || !integer(reply.impact.totalNodes) || !Array.isArray(reply.impact.predicted)
    || !integer(reply.impact.reusedCount) || !integer(reply.impact.estimatedMs)
    || !["local-free", "quote-required"].includes(reply.impact.costType)
    || !Array.isArray(reply.impact.quoteRequired) || !Array.isArray(reply.impact.affectedObjects)
    || !Array.isArray(reply.timelineExports) || !Array.isArray(reply.notes)) throw invalid();
  return reply;
}

export type ContainerProjectSummary = { projectId: string; revision: number; title: string; sceneCount: number; timelineCount: number; firstDocumentId?: string };
export type ContainerProjectPage = { projects: ContainerProjectSummary[]; nextCursor: string | null };
const listId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Metadata only, with a byte ceiling before JSON parsing. */
export async function readContainerList(cursor?: string, signal?: AbortSignal, transport: Transport = appFetch): Promise<ContainerProjectPage> {
  const invalid = () => new Error(t("container.listInvalid"));
  if (cursor !== undefined && !listId.test(cursor)) throw invalid();
  const response = await transport(`/api/project-containers/list?limit=20${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { signal });
  if (!response.ok || !response.body) throw new Error(t("container.listError"));
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) throw invalid();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal?.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const integer = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
  if (!record(value) || Object.keys(value).some(key => !["projects", "nextCursor"].includes(key)) || !Array.isArray(value.projects) || value.projects.length > 20) throw invalid();
  let previous = cursor ?? "";
  for (const row of value.projects) {
    if (!record(row) || Object.keys(row).some(key => !["projectId", "revision", "title", "sceneCount", "timelineCount", "firstDocumentId"].includes(key))
      || typeof row.projectId !== "string" || !listId.test(row.projectId) || row.projectId <= previous
      || !integer(row.revision) || typeof row.title !== "string" || [...row.title].length > 160
      || !integer(row.sceneCount) || !integer(row.timelineCount) || row.sceneCount + row.timelineCount > 10000
      || (row.firstDocumentId !== undefined && (typeof row.firstDocumentId !== "string" || !listId.test(row.firstDocumentId)))) throw invalid();
    previous = row.projectId;
  }
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !listId.test(value.nextCursor) || !value.projects.length || value.nextCursor !== previous)) throw invalid();
  return value as ContainerProjectPage;
}
