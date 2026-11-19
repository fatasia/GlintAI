import { readWorkspace, type GitStorage } from "./project-workspace-storage";

const loadRecovery = () => import("./project-git-storage");

/** Ordinary home startup does not need NLE, design attachments or journal replay. */
export async function recoverStudioWorkspace(storage: GitStorage = localStorage, load = loadRecovery): Promise<Record<string, unknown> | null> {
  const active = storage.getItem("glint:git-active-restore.v1");
  // An active journal owns recovery even when its workspace before-image is corrupt.
  if (active !== null) return (await load()).recoverGitWorkspace(storage);
  const workspace = readWorkspace(storage);
  const projectId = workspace?.project && typeof workspace.project === "object" ? (workspace.project as { id?: unknown }).id : undefined;
  if (typeof projectId === "string" && storage.getItem(`glint:git-restore.v1:${projectId}`) !== null)
    return (await load()).recoverGitWorkspace(storage);
  return workspace;
}

export async function loadLocalGitVersion(projectId: string) {
  return (await loadRecovery()).readLocalGitVersion(projectId);
}
