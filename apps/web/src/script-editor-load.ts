import type { SceneScriptProject } from "@glintai/scenescript";
import {
  createProjectDocuments,
  readProjectDocuments,
  projectDocumentsKey,
  type DocumentStorage,
} from "./script-documents";
import { pendingScriptDrafts, type ScriptDraft } from "./authoring-drafts";

export function loadScriptDraft(
  project: SceneScriptProject,
  storage?: DocumentStorage,
): ScriptDraft {
  const pending = pendingScriptDrafts.get(project.id);
  if (pending) return pending;
  try {
    const state = readProjectDocuments(project.id, storage);
    return {
      state: state.documents.length ? state : createProjectDocuments(project),
      raw: (storage ?? localStorage).getItem(projectDocumentsKey(project.id)),
      error: "",
    };
  } catch (error) {
    return {
      state: createProjectDocuments(project),
      raw: undefined,
      error: (error as Error).message,
    };
  }
}
