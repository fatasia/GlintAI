import type { ProjectDesignDocuments } from "./design-artifacts";
import type { ProjectDocuments } from "./script-documents";

export type ScriptDraft = { state: ProjectDocuments; raw: string | null | undefined; error: string };
export type DesignDraft = { state: ProjectDesignDocuments; raw: string | null | undefined; error: string };

export const pendingScriptDrafts = new Map<string, ScriptDraft>();
export const pendingDesignDrafts = new Map<string, DesignDraft>();

export function readPendingScriptDocuments(projectId: string): ProjectDocuments | undefined {
  const draft = pendingScriptDrafts.get(projectId);
  return draft ? structuredClone(draft.state) : undefined;
}

export function readPendingDesignDocuments(projectId: string): ProjectDesignDocuments | undefined {
  const draft = pendingDesignDrafts.get(projectId);
  return draft ? structuredClone(draft.state) : undefined;
}

export function clearPendingAuthoringDrafts(projectId: string, modules: { script?: boolean; design?: boolean }): void {
  if (modules.script) pendingScriptDrafts.delete(projectId);
  if (modules.design) pendingDesignDrafts.delete(projectId);
}
