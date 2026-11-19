import { appFetch } from "./app-url";
import { type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
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
const SESSION_BACKUP_PREFIX = "glint.session-backup:";

export interface SessionBackup {
  key: string;
  title: string;
  projectId: string;
  createdAt: number | null;
  valid: boolean;
}

/** Preserve unreadable backups in the list so the raw file can still be exported. */
export function readSessionBackups(storage: Storage = globalThis.localStorage): SessionBackup[] {
  const backups: SessionBackup[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(SESSION_BACKUP_PREFIX)) continue;
    const suffix = key.slice(SESSION_BACKUP_PREFIX.length);
    const separator = suffix.lastIndexOf(":");
    const stamp = separator < 0 ? "" : suffix.slice(separator + 1).split("-")[0]!;
    const timestamp = /^\d{13}$/.test(stamp) ? Number(stamp) : null;
    let title = "无法识别的备份", projectId = separator < 0 ? suffix : suffix.slice(0, separator), valid = false;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null");
      const parsed = parseEditorProject(value);
      if (parsed.id !== projectId) throw new Error("Backup identity mismatch");
      title = parsed.title; valid = true;
    } catch { /* Export raw bytes even when the editor cannot parse them. */ }
    backups.push({ key, title, projectId, createdAt: timestamp, valid });
  }
  return backups.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.key.localeCompare(b.key));
}

/** Recover as a separate saved work, never replacing the workspace or evicting another work. */
export async function recoverSessionBackup(key: string, storage: Storage = globalThis.localStorage, transport: typeof fetch = appFetch): Promise<SavedProject> {
  if (!key.startsWith(SESSION_BACKUP_PREFIX)) throw new Error("不是有效的本机备份。");
  const raw = storage.getItem(key);
  if (raw === null) throw new Error("备份已不存在，请刷新列表。");
  const source = parseEditorProject(JSON.parse(raw));
  const identity = key.slice(SESSION_BACKUP_PREFIX.length);
  if (identity.slice(0, identity.lastIndexOf(":")) !== source.id) throw new Error("备份工程编号不匹配，请导出原文件核对。");
  const existing = JSON.parse(storage.getItem("glint.projects") ?? "[]");
  if (!Array.isArray(existing) || existing.length > MAX_ITEMS || !existing.every(isSavedProject)) throw new Error("作品列表无法安全读取，请先导出备份。");
  if (existing.length >= MAX_ITEMS) throw new Error("作品列表已满，请先整理作品或导出备份。");
  const assets = source.assets?.map(asset => {
    if ((asset.kind !== "character" && asset.kind !== "product") || !asset.approval) return asset;
    const { approval: _, ...draft } = asset; return draft;
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const projectId = `${source.id.slice(0, 45)}-recovered-${crypto.randomUUID()}`;
    if (existing.some(item => item.id === projectId || item.project?.id === projectId)) continue;
    const project = { ...source, id: projectId, title: `${source.title} · 备份恢复`, frozen: false, ...(assets ? { assets } : {}) };
    let response: Response, result: { code?: string; snapshot?: { document?: unknown } };
    try { response = await transport("/api/session/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, project, createOnly: true }), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`共享工程创建结果未确认（工程 ID：${projectId}），请在「从 Skill / CLI 继续」查询；当前草稿和备份未变。`); }
    try { result = await response.json(); }
    catch { throw new Error(`共享工程返回无法识别（工程 ID：${projectId}），请在「从 Skill / CLI 继续」查询；当前草稿和备份未变。`); }
    if (response.status === 409 && result.code === "project-conflict") continue;
    if (!response.ok || !result.snapshot?.document || canonicalJson(result.snapshot.document) !== canonicalJson(project)) throw new Error(`共享工程创建未确认（工程 ID：${projectId}）；请在「从 Skill / CLI 继续」查询，当前草稿和备份未变。`);
    // Recheck local storage after the asynchronous reservation. Never evict a
    // work added in another tab while the server was processing the request.
    let current: unknown;
    try { current = JSON.parse(storage.getItem("glint.projects") ?? "[]"); }
    catch { throw new Error(`本机作品列表读取失败，共享副本已创建（工程 ID：${projectId}）；可在「从 Skill / CLI 继续」找回。`); }
    if (!Array.isArray(current) || current.length > MAX_ITEMS || !current.every(isSavedProject)) throw new Error(`作品列表无法安全读取；共享副本已创建（工程 ID：${projectId}），可在「从 Skill / CLI 继续」找回。`);
    if (current.length >= MAX_ITEMS || current.some(item => item.id === projectId || item.project?.id === projectId)) throw new Error(`作品列表已满或编号冲突；共享副本已创建（工程 ID：${projectId}），可在「从 Skill / CLI 继续」找回。`);
    const saved = { id: projectId, name: project.title, mode: "source" as const, text: "", template: "explainer", theme: typeof project.theme === "string" ? project.theme : "glint-dark", aspect: project.aspect, project, updatedAt: Date.now() };
    try { storage.setItem("glint.projects", JSON.stringify([saved, ...current])); }
    catch { throw new Error(`本机存储失败，共享副本已创建（工程 ID：${projectId}）；可在「从 Skill / CLI 继续」找回，原备份未变。`); }
    return saved;
  }
  throw new Error("新工程编号多次冲突，请稍后重试；当前草稿和备份未变。");
}

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

function parseSavedProjectsStrict(raw: string | null): SavedProject[] {
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("作品列表 JSON 已损坏，请先导出备份。"); }
  if (!Array.isArray(parsed)) throw new Error("作品列表必须是数组，请先导出备份。");
  if (parsed.length > MAX_ITEMS) throw new Error("作品列表超过 20 项，请先整理或导出备份。");
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!isSavedProject(item) || (item.project !== undefined && !item.project) ||
      (item.evidence !== undefined && typeof item.evidence !== "string")) {
      throw new Error("作品列表包含非法条目，请先导出备份。");
    }
    if (ids.has(item.id)) throw new Error("作品列表包含重复列表编号，请先整理或导出备份。");
    ids.add(item.id);
  }
  return parsed;
}

export function readSavedProjectsStrict(storage: Pick<Storage, "getItem"> = globalThis.localStorage): SavedProject[] {
  let raw: string | null;
  try { raw = storage.getItem("glint.projects"); }
  catch { throw new Error("无法读取本机作品列表，请检查存储权限。"); }
  return parseSavedProjectsStrict(raw);
}

export function prepareGitProjectRegistration(
  project: SceneScriptProject,
  context: Pick<SavedProject, "mode" | "text" | "template" | "theme"> & { evidence?: string },
  storage: Pick<Storage, "getItem" | "setItem"> = globalThis.localStorage,
): { existing: SavedProject | null; requiresConfirmation: boolean; commit(): SavedProject } {
  let raw: string | null;
  try { raw = storage.getItem("glint.projects"); }
  catch { throw new Error("无法读取本机作品列表，请检查存储权限。"); }
  const previous = parseSavedProjectsStrict(raw);
  try { project = parseEditorProject(project); }
  catch { throw new Error("工程数据无效，无法登记到作品列表。"); }
  const matches = previous.filter(item => item.id === project.id || item.project?.id === project.id);
  if (matches.length > 1) throw new Error("多个作品匹配同一工程，存在歧义，请先整理列表。");
  const existing = matches[0] ?? null;
  if (existing?.id === project.id && existing.project && existing.project.id !== project.id) {
    throw new Error("列表编号与嵌入工程编号冲突，请先核对作品。");
  }
  if (!existing && previous.length >= MAX_ITEMS) throw new Error("作品列表已满 20 项，请先整理作品或导出备份。");
  if (!context || typeof context !== "object") throw new Error("作品登记上下文无效。");
  const next: SavedProject = {
    id: existing?.id ?? project.id,
    name: project.title,
    mode: context.mode,
    text: context.text,
    template: context.template,
    theme: context.theme,
    aspect: project.aspect,
    project,
    updatedAt: Date.now(),
    ...(context.evidence !== undefined ? { evidence: context.evidence } : {}),
  };
  if (!isSavedProject(next) || (next.evidence !== undefined && typeof next.evidence !== "string")) {
    throw new Error("作品登记上下文无效，请检查模式、文本、模板、主题及凭据。");
  }
  const unchanged = existing !== null && canonicalJson(existing.project) === canonicalJson(project);
  const serialized = JSON.stringify(existing
    ? previous.map(item => item === existing ? next : item)
    : [next, ...previous]);
  return {
    existing,
    requiresConfirmation: existing !== null && !unchanged,
    commit() {
      let current: string | null;
      try { current = storage.getItem("glint.projects"); }
      catch { throw new Error("无法读取本机作品列表，登记未提交。"); }
      if (current !== raw) throw new Error("作品列表已被其他操作修改，请重新读取后确认。");
      if (unchanged) return existing!;
      try { storage.setItem("glint.projects", serialized); }
      catch { throw new Error("本机作品列表写入失败，请检查存储空间及权限。"); }
      let written: string | null;
      try { written = storage.getItem("glint.projects"); }
      catch { throw new Error("无法回读作品列表，登记结果未确认，请重新读取核对。"); }
      if (written !== serialized) throw new Error("作品列表写入后核对失败，请重新读取；不会自动回滚覆盖其他修改。");
      return next;
    },
  };
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
