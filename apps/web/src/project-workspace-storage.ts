import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
export type GitStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const activeKey = "glint:git-active-restore.v1";
const workspaceKey = "glint.workspace";
const journalKey = (id: string) => `glint:git-restore.v1:${id}`;
export const gitProjectKey = (id: string) => `glint:git-project.v1:${id}`;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
// Receipts are local to this JavaScript realm: another tab cannot bless its stale autosave.
export const acceptedWorkspaces = new WeakMap<GitStorage, { before: string | null; after: string }>();

/** Compare against the last value this studio read/wrote; never overwrite a foreign tab's workspace. */
export function assertLocalWorkspaceCurrent(expected: string | null, storage: GitStorage = localStorage): void {
  if (storage.getItem(activeKey) !== null) throw new Error("版本恢复日志待核对或清理，未覆盖完整本机版本。");
  const current = storage.getItem(workspaceKey), accepted = acceptedWorkspaces.get(storage);
  if (current !== expected && !(accepted?.before === expected && accepted.after === current))
    throw new Error("其他窗口已更新工作区；当前输入仍保留，未自动覆盖。请先导出当前草稿，再重新载入核对。");
}

export function saveLocalWorkspace(value: Record<string, unknown>, expected: string | null, storage: GitStorage = localStorage): string {
  assertLocalWorkspaceCurrent(expected, storage);
  const previous = storage.getItem(workspaceKey);
  if (previous !== null) {
    // Opening a workspace is not an edit. Preserve exact legacy bytes and metadata
    // instead of rewriting them when the autosave timer first fires.
    try {
      const saved = JSON.parse(previous);
      if (saved && typeof saved === "object" && !Array.isArray(saved) && Object.entries(value).every(([key, item]) =>
        canonicalJson(item ?? null) === canonicalJson(saved[key] ?? (key === "evidence" ? "" : null)))) return previous;
    } catch { /* Existing validation/write path reports non-serializable values. */ }
  }
  const raw = JSON.stringify(value);
  if (bytes(raw) > 4 * 1024 * 1024) throw new Error("本机工作区过大，请先导出备份。");
  storage.setItem(workspaceKey, raw);
  if (storage.getItem(workspaceKey) !== raw) throw new Error("本机工作区保存未通过核对；请导出当前草稿。");
  acceptedWorkspaces.delete(storage);
  return raw;
}

export function readWorkspace(storage: GitStorage): Record<string, unknown> | null {
  const raw = storage.getItem(workspaceKey);
  if (raw === null) return null;
  if (bytes(raw) > 4 * 1024 * 1024) throw new Error("本机工作区过大，请先导出备份。");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("本机工作区无法读取；未覆盖原始资料，请先导出备份。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机工作区格式无效；未覆盖原始资料。");
  return value as Record<string, unknown>;
}


/** Opening a saved snapshot is not permission to bypass an unresolved restore. No disk mutations. */
export function assertGitStorageReady(projectId?: string, storage: GitStorage = localStorage): void {
  if (storage.getItem(activeKey) !== null || projectId && storage.getItem(journalKey(projectId)) !== null)
    throw new Error("本机恢复日志待核对或清理；请先重试本机恢复，未打开旧作品快照。");
}

/** Read only the explicitly addressed project; never enumerate historical storage. */
export function readGitProject(projectId: string, storage: GitStorage = localStorage): SceneScriptProject | null {
  assertGitStorageReady(projectId, storage);
  const raw = storage.getItem(gitProjectKey(projectId));
  if (raw === null) return null;
  try {
    if (bytes(raw) > 2 * 1024 * 1024) throw new Error();
    const project = parseProject(JSON.parse(raw));
    if (project.id !== projectId) throw new Error();
    return project;
  } catch { throw new Error("完整本机工程无法安全读取；请先导出备份，未降级打开旧作品。"); }
}

export function sameGitProject(left: SceneScriptProject, right: SceneScriptProject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

