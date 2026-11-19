import { parseNleProject, parseProject, parseProjectWorkspace, type ProjectWorkspace, type NleProject, type SceneScriptProject } from "@glintai/scenescript";
export type { ProjectWorkspace } from "@glintai/scenescript";
import { isLocalAgentAvailable, localAgentRequest } from "./local-agent-client";
import type { ScriptDocument } from "./script-documents";
export type { ScriptDocument } from "./script-documents";

export type GitProject = SceneScriptProject | NleProject;
export type GitKind = "scene" | "nle";
export interface ProjectGitProps {
  project: GitProject;
  kind: GitKind;
  documents?: ScriptDocument[];
  workspace?: ProjectWorkspace;
  getWorkspace?(): ProjectWorkspace;
  getStorageSignature?(): string;
  onApply(next: GitProject, documents?: ScriptDocument[], workspace?: ProjectWorkspace): void | boolean;
  onCopy?(next: GitProject, documents?: ScriptDocument[], workspace?: ProjectWorkspace): void | boolean;
  onClose?(): void;
}
export interface GitFile { path: string; status: string }
export interface GitDiffFile extends GitFile { before: unknown; after: unknown }
export interface GitStatus {
  current: string | null;
  versionCount: number;
  changedFiles: GitFile[];
  mediaRefs: unknown[];
  mediaPolicy: unknown;
}
export interface GitVersion {
  id: string;
  parent: string | null;
  parents: string[];
  message: string;
  at: number;
  deleted: boolean;
  current: boolean;
}
export interface GitHistory { versions: GitVersion[]; more: boolean; deletedCount: number }
export interface GitSnapshot { project: GitProject; documents?: ScriptDocument[]; projectId?: string; workspace?: ProjectWorkspace }
export type GitOperation = "open" | "status" | "history" | "diff" | "commit" | "checkout" | "copy" | "discard" | "deleteVersions" | "recoverVersions";
export const gitAvailable = isLocalAgentAvailable;
export const captureGit = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const gitSignature = (project: GitProject, documents?: ScriptDocument[], workspace?: ProjectWorkspace) => JSON.stringify([project, documents ?? [], workspace ?? null]);
const invalid = () => new Error("本地 Git 返回的数据不完整，请刷新版本列表后重试。");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const file = (value: unknown): value is GitFile => record(value) && typeof value.path === "string" && typeof value.status === "string";

export async function projectGitRequest<T>(projectId: string, kind: GitKind, operation: GitOperation, payload: Record<string, unknown> = {}): Promise<T> {
  if (!gitAvailable()) throw new Error("本地 Git 版本仅在桌面版可用，请在 Glint 桌面版打开此工程。");
  try { return await localAgentRequest<T>({ ...payload, action: "git", operation, projectId, kind }); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "操作未完成，请检查桌面连接后重试。";
    throw new Error(message.replaceAll("本地智能体", "本地 Git"));
  }
}
export function readGitStatus(value: unknown): GitStatus {
  if (!record(value) || !(value.current === null || typeof value.current === "string") || !count(value.versionCount)
    || !Array.isArray(value.changedFiles) || !value.changedFiles.every(file) || !Array.isArray(value.mediaRefs) || value.mediaPolicy === undefined) throw invalid();
  return value as unknown as GitStatus;
}
export function readGitHistory(value: unknown): GitHistory {
  if (!record(value) || !Array.isArray(value.versions) || typeof value.more !== "boolean" || !count(value.deletedCount)) throw invalid();
  const versions = value.versions;
  if (!versions.every(item => record(item) && typeof item.id === "string" && item.id.length > 0 && typeof item.message === "string"
    && typeof item.at === "number" && Number.isFinite(item.at) && (item.parent === null || typeof item.parent === "string")
    && Array.isArray(item.parents) && item.parents.every(parent => typeof parent === "string") && typeof item.deleted === "boolean" && typeof item.current === "boolean")
    || new Set(versions.map(item => item.id)).size !== versions.length) throw invalid();
  return value as unknown as GitHistory;
}
export function readGitDiff(value: unknown): GitDiffFile[] {
  if (!record(value) || !Array.isArray(value.files) || !value.files.every(item => file(item) && "before" in item && "after" in item)) throw invalid();
  return value.files as GitDiffFile[];
}
export function readGitSnapshot(value: unknown, kind: GitKind, sourceId: string, copy = false): GitSnapshot {
  if (!record(value) || !record(value.project)) throw invalid();
  const project = kind === "scene" ? parseProject(value.project) : parseNleProject(value.project);
  if (copy ? project.id === sourceId : project.id !== sourceId) throw new Error(copy ? "副本没有独立的工程编号，未载入编辑器。" : "返回内容属于其他工程，未载入编辑器。");
  if (value.documents !== undefined && (!Array.isArray(value.documents) || !value.documents.every(item => record(item) && typeof item.id === "string" && typeof item.title === "string" && typeof item.content === "string"
    && ["script", "screenplay", "outline", "narration"].includes(String(item.kind)) && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)))) throw invalid();
  const workspace = value.workspace === undefined ? undefined : parseProjectWorkspace(value.workspace, project.id);
  return { project, documents: value.documents as ScriptDocument[] | undefined, projectId: typeof value.projectId === "string" ? value.projectId : undefined, ...(workspace ? { workspace } : {}) };
}
export function gitValue(value: unknown): string {
  return value === null || value === undefined ? "（无内容）" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
export function gitSummary(files: GitDiffFile[]): string {
  const source = files.find(item => /(^|\/)project\.json$/.test(item.path))?.after;
  try {
    const project = typeof source === "string" ? JSON.parse(source) : source;
    if (!record(project)) return `${files.length} 个文件变化；展开文件查看文本内容。`;
    const scenes = Array.isArray(project.scenes) ? project.scenes.length : undefined;
    const tracks = Array.isArray(project.tracks) ? project.tracks : undefined;
    return [typeof project.title === "string" ? project.title : "工程快照", scenes === undefined ? undefined : `${scenes} 个镜头`, tracks ? `${tracks.length} 条轨道 · ${tracks.reduce((sum, track) => sum + (record(track) && Array.isArray(track.clips) ? track.clips.length : 0), 0)} 个片段` : undefined].filter(Boolean).join(" · ");
  } catch { return `${files.length} 个文件变化；展开文件查看文本内容。`; }
}
export const gitFileLabel = (status: string) => ({ A: "新增", M: "修改", D: "删除", R: "重命名", "??": "新增", added: "新增", modified: "修改", deleted: "删除" }[status.trim()] ?? status);
export const gitTime = (at: number) => new Date(at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
