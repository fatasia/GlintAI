import { type SceneScriptProject } from "@glintai/scenescript";
import { parseEditorProject } from "./editor-model";
export interface SavedProject {
  id: string;
  name: string;
  mode: "source" | "idea";
  text: string;
  template: string;
  theme: string;
  aspect: string;
  updatedAt: number;
  project?: SceneScriptProject;
  evidence?: string;
}

const MAX_ITEMS = 20;

export function readSavedProjects(storage?: Pick<Storage, "getItem">): SavedProject[] {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return [];
    const parsed = JSON.parse(storage.getItem("glint.projects") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isSavedProject).slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

export function saveProject(project: Omit<SavedProject, "updatedAt">, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): SavedProject {
  const next = { ...project, updatedAt: Date.now() };
  if (storage) {
    const previous = readSavedProjects(storage).filter((item) => item.id !== project.id);
    storage.setItem("glint.projects", JSON.stringify([next, ...previous].slice(0, MAX_ITEMS)));
  }
  return next;
}

export function removeProject(id: string, storage: Pick<Storage, "setItem" | "getItem"> | undefined = globalThis.localStorage): void {
  if (!storage) return;
  storage.setItem("glint.projects", JSON.stringify(readSavedProjects(storage).filter((item) => item.id !== id)));
}

function isSavedProject(value: unknown): value is SavedProject {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SavedProject>;
  if (item.project) { try { parseEditorProject(item.project); } catch { return false; } }
  return typeof item.id === "string" && typeof item.name === "string" &&
    (item.mode === "source" || item.mode === "idea") && typeof item.text === "string" &&
    typeof item.template === "string" && typeof item.theme === "string" &&
    typeof item.aspect === "string" && Number.isFinite(item.updatedAt);
}
