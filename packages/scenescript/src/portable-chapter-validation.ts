import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateChapterManifest } from "./chapter-bundle";
import type { SceneScriptProject } from "./types";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCES = 5000;
const MAX_SNAPSHOTS_BYTES = 2_000_000;
const FORMAT = "glint-chapters-portable";

type Context = { mode: "source" | "idea"; text: string; template: string; theme: string; evidence: string };
export type PortableSnapshot = { title: string; updatedAt: number; project: SceneScriptProject; context: Context };
type PortableAsset = { path: string; sha256: string; bytes: number; data: string };
export type ValidatedPortableBundle = {
  chapters: Array<{ snapshot: PortableSnapshot; assets: Array<{ path: string; sha256: string; bytes: number }> }>;
  blobs: Map<string, { extension: string; bytes: Buffer }>;
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function snapshot(value: unknown): Omit<PortableSnapshot, "project"> & { project: unknown } {
  if (!object(value) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 100 ||
      !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 || !object(value.context)) throw new Error("章节快照信息无效。");
  const context = value.context;
  if ((context.mode !== "source" && context.mode !== "idea") || typeof context.text !== "string" || context.text.length > 12000 ||
      typeof context.template !== "string" || context.template.length > 100 || typeof context.theme !== "string" || context.theme.length > 100 ||
      typeof context.evidence !== "string" || context.evidence.length > 100000) throw new Error("章节资料上下文无效。");
  return { title: value.title.trim(), updatedAt: value.updatedAt as number, project: value.project,
    context: { mode: context.mode, text: context.text, template: context.template, theme: context.theme, evidence: context.evidence } };
}

function matchesMedia(bytes: Buffer, extension: string): boolean {
  if (extension === "png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === "jpg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === "webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (extension === "wav") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  if (extension === "mp4") return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (extension === "mp3") return bytes.length >= 3 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1]! & 224) === 224));
  return false;
}

/** Parse and validate the complete package before any installation side effect. */
export function validatePortableChapterBundle(serialized: string): ValidatedPortableBundle {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("章节包超过 32 MiB。");
  let input: unknown;
  try { input = JSON.parse(serialized); } catch { throw new Error("章节包不是有效的 JSON。"); }
  if (!object(input) || input.format !== FORMAT || input.version !== 2 || !Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > 100) {
    throw new Error("仅支持包含完整章节快照的版本 2 迁移包；旧版本缺少资料上下文，无法安全导入。");
  }
  const blobs = new Map<string, { extension: string; bytes: Buffer }>();
  const metadata: Array<ReturnType<typeof snapshot>> = [];
  const chapters: Array<{ project: unknown; assets: Array<{ path: string; sha256: string; bytes: number }> }> = [];
  let references = 0;
  for (const raw of input.chapters) {
    if (!object(raw) || !Array.isArray(raw.assets)) throw new Error("章节资源清单无效。");
    const snap = snapshot(raw.snapshot);
    metadata.push(snap);
    const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const value of raw.assets) {
      if (++references > MAX_REFERENCES || !object(value)) throw new Error("章节包资源条目无效或超过上限。");
      const entry = value as unknown as PortableAsset;
      if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_DOCUMENT_BYTES || typeof entry.data !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) throw new Error("章节包资源条目无效。");
      const extension = /\.(png|jpg|webp|mp4|mp3|wav)$/.exec(entry.path)?.[1];
      if (!extension) throw new Error("章节包包含不支持的素材类型。");
      const bytes = Buffer.from(entry.data, "base64");
      if (bytes.toString("base64") !== entry.data || bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || !matchesMedia(bytes, extension)) {
        throw new Error(`章节包素材校验失败：${entry.path}`);
      }
      const existing = blobs.get(entry.sha256);
      if (existing && (existing.extension !== extension || !existing.bytes.equals(bytes))) throw new Error("相同内容使用不一致的素材类型。");
      if (!existing) blobs.set(entry.sha256, { extension, bytes });
      entries.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
    }
    chapters.push({ project: snap.project, assets: entries });
  }
  const manifest = validateChapterManifest({ version: 1, chapters });
  for (const { project } of manifest.chapters) {
    const requireEmbedded = (ref: string, label: string) => {
      if (!ref.startsWith("assets/")) throw new Error(`工程 ${project.id} 的${label}不在迁移包素材目录中。`);
    };
    if (project.music) requireEmbedded(project.music.src, "背景音乐");
    for (const asset of project.assets ?? []) for (const ref of asset.refs ?? []) requireEmbedded(ref, "身份素材");
    for (const scene of project.scenes) {
      // HTML/CSS/JS may embed relative or remote resources that are not represented
      // by the manifest. Until those dependencies can be enumerated reliably,
      // accepting such a scene would falsely claim a complete migration.
      if (scene.kind === "html") throw new Error("HTML 场景的内嵌资源尚无法完整验证，暂不支持含素材迁移。");
      if (scene.narration.audioRef) requireEmbedded(scene.narration.audioRef, "旁白音频");
      if (scene.kind === "image" || scene.kind === "video" || (scene.kind === "three" && scene.model === "gltf")) requireEmbedded(scene.src, "场景素材");
    }
  }
  const result = manifest.chapters.map((chapter, index) => ({ snapshot: { ...metadata[index]!, project: chapter.project }, assets: chapter.assets }));
  if (!isDeepStrictEqual(input.chapters.map(chapter => object(chapter) ? chapter.snapshot : undefined), result.map(item => item.snapshot))) throw new Error("章节快照包含无法完整恢复的数据，请先检查工程格式。");
  if (Buffer.byteLength(JSON.stringify(result.map(item => item.snapshot), null, 2), "utf8") > MAX_SNAPSHOTS_BYTES) throw new Error("章节快照超过 2 MB。");
  return { chapters: result, blobs };
}
