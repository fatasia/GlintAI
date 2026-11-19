import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { parseEditorProject } from "./editor-model";

export const CHAPTERS_KEY = "glint.chapters.references.v1";
export const MAX_CHAPTERS_BYTES = 2_000_000;
const CHAPTERS_LOCK = "glint.chapters.references.v1.write";
/** All cooperating tabs must hold this lock from the baseline check through the write. */
export async function withChapterWriteLock<T>(task: () => Promise<T> | T): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) throw new Error("此浏览器不支持安全的跨标签章节锁；请使用支持 Web Locks 的浏览器，原数据未修改。");
  return navigator.locks.request(CHAPTERS_LOCK, { mode: "exclusive", ifAvailable: true }, lock => {
    if (!lock) throw new Error("其他标签页正在修改章节，请稍后重试；原数据未修改。");
    return task();
  });
}
const MAX_CHAPTERS = 100;
export interface ChapterContext { mode: "source" | "idea"; text: string; template: string; theme: string; evidence: string }
export interface ChapterSnapshot { title: string; updatedAt: number; project: SceneScriptProject; context: ChapterContext }
export interface ChaptersDocument { kind: "glint.chapters.references"; version: 1; chapters: ChapterSnapshot[] }
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = StorageReader & Pick<Storage, "setItem">;
const identity = (id: string) => id.normalize("NFC").toLowerCase();
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function validateContext(value: unknown): ChapterContext {
  if (!record(value) || !["source", "idea"].includes(String(value.mode)) || typeof value.text !== "string" || value.text.length > 12_000 ||
    typeof value.template !== "string" || value.template.length > 100 || typeof value.theme !== "string" || value.theme.length > 100 ||
    typeof value.evidence !== "string" || value.evidence.length > 100_000) throw new Error("章节资料上下文无效。");
  return { mode: value.mode as ChapterContext["mode"], text: value.text, template: value.template, theme: value.theme, evidence: value.evidence };
}
function assertAssetVersions(chapters: ChapterSnapshot[]) {
  const versions = new Map<string, string>();
  for (const { project } of chapters) for (const asset of project.assets ?? []) {
    const key = `${asset.id}\0${asset.version}`, signature = JSON.stringify(asset);
    if (versions.has(key) && versions.get(key) !== signature) throw new Error(`跨章节资产 ${asset.id} · ${asset.version} 不一致；请统一资产或使用新版本。`);
    versions.set(key, signature);
  }
}
export function parseChaptersDocument(value: unknown): ChaptersDocument {
  if (!record(value) || value.kind !== "glint.chapters.references" || value.version !== 1 || !Array.isArray(value.chapters)) {
    throw new Error("请选择 Glint 导出的章节引用 JSON；CLI 素材章节包请通过 CLI 恢复。");
  }
  if (value.chapters.length > MAX_CHAPTERS) throw new Error("最多管理 100 个章节。");
  const ids = new Set<string>();
  const chapters = value.chapters.map(raw => {
    if (!record(raw) || typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 100 || typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) throw new Error("章节名称或保存时间无效。");
    const project = parseEditorProject(raw.project), id = identity(project.id);
    if (ids.has(id)) throw new Error(`章节工程 ID 重复：${project.id}。请先移除旧章节或在编辑区显式更新快照。`);
    ids.add(id);
    return { title: raw.title.trim(), updatedAt: raw.updatedAt, project, context: validateContext(raw.context) };
  });
  assertAssetVersions(chapters);
  const result: ChaptersDocument = { kind: "glint.chapters.references", version: 1, chapters };
  // Match the formatted export so every accepted local document can be re-imported.
  if (new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength > MAX_CHAPTERS_BYTES) throw new Error("章节引用 JSON 超过 2 MB，请减少章节或工程内容。");
  return result;
}
export function chaptersDocument(chapters: ChapterSnapshot[]): ChaptersDocument { return parseChaptersDocument({ kind: "glint.chapters.references", version: 1, chapters }); }
export function readChapters(storage: StorageReader = localStorage): ChapterSnapshot[] {
  const raw = storage.getItem(CHAPTERS_KEY);
  if (!raw) return [];
  if (raw.length > MAX_CHAPTERS_BYTES) throw new Error("本机章节数据过大；原数据未修改。");
  return parseChaptersDocument(JSON.parse(raw)).chapters;
}
/** Commit only after validating the complete candidate; failed writes never replace UI state. */
export function writeChapters(chapters: ChapterSnapshot[], storage: StorageWriter = localStorage): ChapterSnapshot[] {
  const next = chaptersDocument(chapters);
  storage.setItem(CHAPTERS_KEY, JSON.stringify(next));
  return next.chapters;
}
export function captureChapter(project: SceneScriptProject, context: ChapterContext): ChapterSnapshot {
  return chaptersDocument([{ title: project.title.slice(0, 100), updatedAt: Date.now(), project, context }]).chapters[0]!;
}
export function mergeChapters(current: ChapterSnapshot[], incoming: ChapterSnapshot[]): ChapterSnapshot[] {
  return chaptersDocument([...current, ...incoming]).chapters;
}
export function moveChapter(chapters: ChapterSnapshot[], id: string, delta: -1 | 1): ChapterSnapshot[] {
  const index = chapters.findIndex(chapter => chapter.project.id === id), target = index + delta;
  if (index < 0 || target < 0 || target >= chapters.length) return chapters;
  const next = [...chapters]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
}
function mediaReferences(project: SceneScriptProject): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("assets/")) found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (record(value)) Object.values(value).forEach(walk);
  };
  walk(project); return found;
}
/** Reference equality is not a file hash or proof that two media files are identical. */
export function summarizeChapters(chapters: ChapterSnapshot[]) {
  const assets = new Map<string, Set<string>>(), refs = new Map<string, Set<string>>();
  for (const { project } of chapters) {
    for (const asset of project.assets ?? []) {
      const key = `${asset.id}\0${asset.version}`, owners = assets.get(key) ?? new Set<string>(); owners.add(project.id); assets.set(key, owners);
    }
    for (const ref of mediaReferences(project)) { const owners = refs.get(ref) ?? new Set<string>(); owners.add(project.id); refs.set(ref, owners); }
  }
  return {
    scenes: chapters.reduce((sum, chapter) => sum + chapter.project.scenes.length, 0),
    totalMs: chapters.reduce((sum, chapter) => sum + buildTimeline(chapter.project).totalMs, 0),
    sharedAssets: [...assets.values()].filter(owners => owners.size > 1).length,
    sharedReferences: [...refs.values()].filter(owners => owners.size > 1).length,
    chapters: chapters.map(({ project }) => ({ id: project.id, scenes: project.scenes.length, totalMs: buildTimeline(project).totalMs,
      sharedAssets: [...assets.values()].filter(owners => owners.has(project.id) && owners.size > 1).length,
      sharedReferences: [...refs.values()].filter(owners => owners.has(project.id) && owners.size > 1).length })),
  };
}
