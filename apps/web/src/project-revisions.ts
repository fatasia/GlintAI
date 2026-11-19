import type { SavedProject } from "./project-history";

/**
 * Durable edit history for one saved work, modelled on InkOS-style artifact
 * revisions: every meaningful save leaves a labelled snapshot, restoring is a
 * preview that never overwrites the stored work, and a branch is a new work
 * with its own id. SceneScript/NLE sessions already cover in-memory undo; this
 * is the durable layer across reloads and generation runs.
 */
export type RevisionReason = "manual" | "generated" | "restore" | "branch";

export interface ProjectRevision {
  version: 1;
  id: string;
  projectId: string;
  at: number;
  label: string;
  reason: RevisionReason;
  snapshot: SavedProject;
}

const MAX_REVISIONS = 40;
export const revisionKey = (projectId: string) => `glint.revisions.v1:${projectId}`;

function fingerprint(snapshot: SavedProject): string {
  return JSON.stringify({
    text: snapshot.text, mode: snapshot.mode, template: snapshot.template,
    theme: snapshot.theme, aspect: snapshot.aspect, project: snapshot.project ?? null,
    evidence: snapshot.evidence ?? "",
  });
}

function isRevision(value: unknown): value is ProjectRevision {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectRevision>;
  return item.version === 1 && typeof item.id === "string" && typeof item.projectId === "string" &&
    Number.isFinite(item.at) && typeof item.label === "string" &&
    (item.reason === "manual" || item.reason === "generated" || item.reason === "restore" || item.reason === "branch") &&
    Boolean(item.snapshot) && typeof item.snapshot === "object" && typeof item.snapshot.id === "string";
}

export function readRevisions(projectId: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): ProjectRevision[] {
  if (!projectId || !storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(revisionKey(projectId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isRevision).slice(0, MAX_REVISIONS) : [];
  } catch {
    return [];
  }
}

/**
 * Append a snapshot unless it is byte-identical to the newest one. Returns the
 * stored revision, or null when storage is unavailable/quota-full.
 */
export function recordRevision(
  snapshot: SavedProject,
  options: { label: string; reason: RevisionReason; now?: number; storage?: Pick<Storage, "getItem" | "setItem"> },
): ProjectRevision | null {
  const storage = options.storage ?? globalThis.localStorage;
  if (!storage) return null;
  const existing = readRevisions(snapshot.id, storage);
  if (existing[0] && fingerprint(existing[0].snapshot) === fingerprint(snapshot)) return existing[0];
  const revision: ProjectRevision = {
    version: 1,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: snapshot.id,
    at: options.now ?? Date.now(),
    label: options.label.slice(0, 80) || "未命名版本",
    reason: options.reason,
    snapshot: structuredClone(snapshot),
  };
  try {
    storage.setItem(revisionKey(snapshot.id), JSON.stringify([revision, ...existing].slice(0, MAX_REVISIONS)));
    return revision;
  } catch {
    return null;
  }
}

/** Load a revision into the editor without touching the stored work. */
export function restoreRevision(revision: ProjectRevision, now = Date.now()): SavedProject {
  return { ...structuredClone(revision.snapshot), updatedAt: now };
}

/** Fork a revision into a new independent work id; the source revision stays untouched. */
export function branchRevision(revision: ProjectRevision, name?: string, now = Date.now()): SavedProject {
  const id = crypto.randomUUID();
  const snapshot = structuredClone(revision.snapshot);
  const branchName = (name?.trim() || `${snapshot.name} · 分支`).slice(0, 80);
  const project = snapshot.project ? { ...snapshot.project, id } : undefined;
  return { ...snapshot, id, name: branchName, updatedAt: now, ...(project ? { project } : {}) };
}

export function clearRevisions(projectId: string, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  if (!storage || !projectId) return;
  try { storage.setItem(revisionKey(projectId), "[]"); } catch { /* quota/storage disabled */ }
}

/** Human-readable delta between two snapshots; used by the history list. */
export function revisionDelta(before: ProjectRevision | undefined, after: SavedProject): { scenes: number; textChars: number; changed: string[] } {
  const previous = before?.snapshot;
  const changed: string[] = [];
  if (!previous) changed.push("首个版本");
  else {
    if (previous.text !== after.text) changed.push("资料");
    if (previous.theme !== after.theme) changed.push("风格");
    if (previous.aspect !== after.aspect) changed.push("画幅");
    if (JSON.stringify(previous.project?.scenes ?? []) !== JSON.stringify(after.project?.scenes ?? [])) changed.push("分镜");
    if ((previous.evidence ?? "") !== (after.evidence ?? "")) changed.push("依据");
  }
  return { scenes: after.project?.scenes.length ?? 0, textChars: after.text.length, changed };
}
