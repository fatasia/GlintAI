import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { readSavedProjectsStrict, type SavedProject } from "./project-history";
import { gitProjectKey, readGitProject, readLocalGitVersion, sameGitProject } from "./project-git-storage";

export type GitSourceContext = Pick<SavedProject, "mode" | "text" | "template" | "theme"> & { evidence?: string };
type SourceRecord = { version: 1; project: SceneScriptProject; context: GitSourceContext };
export type LocalGitWork = { id: string; title: string; project?: SceneScriptProject; error?: string };
export type LocalGitSelection = ReturnType<typeof readLocalGitWork>;
const sourceKey = (id: string) => `glint:git-source.v1:${id}`;
const prefix = "glint:git-project.v1:";
const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,199}$/.test(id);
const message = (cause: unknown) => cause instanceof Error ? cause.message : "本机存储不可用，请先导出备份。";

function parseSource(raw: string, projectId: string): SourceRecord {
  try {
    if (new TextEncoder().encode(raw).byteLength > 3 * 1024 * 1024) throw new Error();
    const value = JSON.parse(raw) as SourceRecord;
    const project = parseProject(value.project), context = value.context;
    if (value.version !== 1 || project.id !== projectId || Object.keys(value).some(key => !["version", "project", "context"].includes(key)) ||
      !context || typeof context !== "object" || Array.isArray(context) ||
      Object.keys(context).some(key => !["mode", "text", "template", "theme", "evidence"].includes(key)) ||
      !["source", "idea"].includes(context.mode) || typeof context.text !== "string" || context.text.length > 12000 ||
      typeof context.template !== "string" || typeof context.theme !== "string" ||
      context.evidence !== undefined && typeof context.evidence !== "string") throw new Error();
    return { version: 1, project, context };
  } catch { throw new Error("此工程的原资料记录无法读取；记录未改动，可导出核对或明确使用空资料。"); }
}

/** One independently addressed provenance record per accepted main snapshot, not an array queue. */
export function rememberLocalGitSource(project: SceneScriptProject, context: GitSourceContext, storage: Storage = localStorage): void {
  const local = readLocalGitVersion(project.id, storage);
  if (!sameGitProject(local.project, project)) throw new Error("本机主快照已变化，未记录过期原资料。");
  const key = sourceKey(project.id), before = storage.getItem(key);
  if (before !== null && sameGitProject(parseSource(before, project.id).project, project)) return;
  const raw = JSON.stringify({ version: 1, project, context });
  parseSource(raw, project.id);
  local.assertCurrent();
  if (storage.getItem(key) !== before) throw new Error("原资料记录已被其他窗口更新，未覆盖。");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("原资料记录写入未确认；本机主快照仍保留，可从本机工程列表找回。");
}

/** Explicit discovery only. Never replay journals, repair a list, resurrect entries or delete source data. */
export function findLocalGitWorks(storage: Storage = localStorage): { works: LocalGitWork[]; notice: string } {
  let saved: SavedProject[] = [], notice = "";
  try { saved = readSavedProjectsStrict(storage); }
  catch (cause) { notice = message(cause); }
  const ids = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  const works: LocalGitWork[] = [];
  for (const id of [...ids].sort()) {
    if (!validId(id)) { works.push({ id, title: id || "无编号记录", error: "工程编号无效；原始记录保留，请导出核对。" }); continue; }
    try {
      const project = readGitProject(id, storage);
      if (!project) continue;
      const matches = saved.filter(item => item.id === id || item.project?.id === id);
      if (matches.length === 1 && matches[0]!.project && sameGitProject(matches[0]!.project!, project)) continue;
      works.push({ id, title: project.title, project });
    } catch (cause) { works.push({ id, title: id, error: message(cause) }); }
  }
  return { works, notice };
}

export function readLocalGitWork(id: string, storage: Storage = localStorage) {
  if (!validId(id)) throw new Error("本机工程编号无效。");
  const local = readLocalGitVersion(id, storage), raw = storage.getItem(sourceKey(id));
  let context: GitSourceContext | undefined, warning = "";
  if (raw !== null) {
    try {
      const source = parseSource(raw, id);
      if (sameGitProject(source.project, local.project)) context = source.context;
      else warning = "原资料记录属于另一个主快照，未套用旧资料。";
    } catch (cause) { warning = message(cause); }
  }
  const assertCurrent = () => {
    local.assertCurrent();
    if (storage.getItem(sourceKey(id)) !== raw) throw new Error("原资料记录已变化，未载入过期工程；请重新核对本机工程。");
  };
  assertCurrent();
  return { project: local.project, context, warning, assertCurrent };
}
