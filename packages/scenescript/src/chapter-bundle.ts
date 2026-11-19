import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseProject } from "./parse";
import { isSafeRelativeAssetPath } from "./assets";
import type { SceneScriptProject } from "./types";

/** Portable, content-addressed collection of independently editable chapters. */
type Entry = { path: string; sha256: string; bytes: number };
type Chapter = { project: SceneScriptProject; assets: Entry[] };
type Manifest = { version: 1; chapters: Chapter[] };
const MAX_CHAPTERS = 100, MAX_REFS = 5000, MAX_ASSET_BYTES = 256 * 1024 * 1024, MAX_EXPANDED = 2 * 1024 * 1024 * 1024, MAX_MANIFEST = 10 * 1024 * 1024;
const safeRef = (value: string) => value.startsWith("assets/") && isSafeRelativeAssetPath(value);
export function referencedAssets(project: SceneScriptProject): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, location: string[] = []): void => {
    const userText = location.length === 1 && location[0] === "title" ||
      location.length === 3 && location[0] === "scenes" && location[2] === "notes" ||
      location.length === 4 && location[0] === "scenes" && location[2] === "narration" && location[3] === "text";
    if (userText) return;
    if (typeof value === "string" && value.startsWith("assets/")) {
      if (!safeRef(value)) throw new Error(`不安全的资源路径：${value}`);
      found.add(value);
    } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...location, String(index)]));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, [...location, key]);
  };
  walk(project); return [...found].sort();
}
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Reject symlinks at every path component, including parent directories. */
function regularUnder(root: string, relative: string): string {
  if (!safeRef(relative)) throw new Error(`不安全的资源路径：${relative}`);
  const base = path.resolve(root);
  if (fs.lstatSync(base).isSymbolicLink() || !fs.statSync(base).isDirectory()) throw new Error("资源根目录不可为符号链接。");
  let current = base;
  for (const [index, part] of relative.split("/").entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < relative.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`资源不是受控普通文件：${relative}`);
  }
  return current;
}
function digest(file: string): { sha256: string; bytes: number } {
  const fd = fs.openSync(file, "r"), hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
      bytes += count; if (bytes > MAX_ASSET_BYTES) throw new Error("单个资源超过 256 MiB 上限。");
      hash.update(chunk.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  if (!bytes) throw new Error("资源文件为空。");
  return { sha256: hash.digest("hex"), bytes };
}
function verifyIdentities(chapters: Chapter[]): void {
  const seen = new Map<string, string>();
  for (const chapter of chapters) for (const asset of chapter.project.assets ?? []) {
    const key = `${asset.id}\0${asset.version}`;
    const images = (asset.refs ?? []).map(ref => {
      const entry = chapter.assets.find(item => item.path === ref);
      if (!entry) throw new Error(`资产 ${asset.id} 的引用缺失：${ref}`);
      return { path: ref, sha256: entry.sha256 };
    });
    const signature = JSON.stringify({ asset, images });
    const previous = seen.get(key);
    if (previous !== undefined && previous !== signature) throw new Error(`跨章节资产 ${asset.id} 版本 ${asset.version} 不一致；请先统一或使用新版本。`);
    seen.set(key, signature);
  }
}
export function validateChapterManifest(input: unknown): Manifest {
  if (!input || typeof input !== "object") throw new Error("章节包清单无效。");
  const raw = input as Partial<Manifest>;
  if (raw.version !== 1 || !Array.isArray(raw.chapters) || raw.chapters.length < 1 || raw.chapters.length > MAX_CHAPTERS) throw new Error("章节数量或版本无效。");
  const ids = new Set<string>(); let count = 0, expanded = 0;
  const chapters = raw.chapters.map(item => {
    const project = parseProject(item.project);
    const portableId = project.id.normalize("NFC").toLowerCase();
    if (project.id.includes("/") || !isSafeRelativeAssetPath(project.id) || ids.has(portableId)) throw new Error(`工程 ID 无效或重复：${project.id}`);
    ids.add(portableId);
    if (!Array.isArray(item.assets)) throw new Error("章节资源清单无效。");
    const refs = referencedAssets(project), entries: Entry[] = [], names = new Set<string>(), portableNames = new Set<string>();
    for (const entry of item.assets) {
      if (!entry || typeof entry.path !== "string" || !safeRef(entry.path) || names.has(entry.path) || !validHash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_ASSET_BYTES) throw new Error("章节资源条目无效。");
      const portable = entry.path.normalize("NFC").toLowerCase();
      if (portableNames.has(portable)) throw new Error("资源路径存在大小写或 Unicode 规范化冲突。");
      portableNames.add(portable); names.add(entry.path); count++; expanded += entry.bytes;
      if (count > MAX_REFS || expanded > MAX_EXPANDED) throw new Error("章节包展开资源超过限制。");
      entries.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
    }
    const sorted = [...portableNames].sort();
    if (sorted.some((name, index) => index > 0 && name.startsWith(`${sorted[index - 1]}/`))) throw new Error("资源文件与目录路径冲突。");
    if (refs.length !== entries.length || refs.some(ref => !names.has(ref))) throw new Error(`工程 ${project.id} 的资源清单不完整。`);
    return { project, assets: entries };
  });
  verifyIdentities(chapters); return { version: 1, chapters };
}

export function writeChapterBundle(inputs: Array<{ project: SceneScriptProject; root: string }>, outDir: string): Manifest {
  if (!inputs.length || inputs.length > MAX_CHAPTERS) throw new Error("章节数必须在 1 到 100 之间。");
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) throw new Error("目标目录已存在，不会覆盖。");
  const sources = new Map<string, string>(); let expanded = 0, count = 0;
  const chapters = inputs.map(input => {
    const project = parseProject(input.project);
    const assets = referencedAssets(project).map(ref => {
      const file = regularUnder(input.root, ref), data = digest(file);
      expanded += data.bytes; count++;
      if (count > MAX_REFS || expanded > MAX_EXPANDED) throw new Error("章节包资源超过限制。");
      sources.set(data.sha256, file); return { path: ref, ...data };
    });
    return { project, assets };
  });
  const manifest = validateChapterManifest({ version: 1, chapters });
  const serialized = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(serialized) > MAX_MANIFEST) throw new Error("章节包清单超过 10 MiB。");
  fs.mkdirSync(out);
  try {
    const blobs = path.join(out, "assets"); fs.mkdirSync(blobs);
    for (const [hash, source] of sources) {
      const target = path.join(blobs, `${hash}.blob`); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (digest(target).sha256 !== hash) throw new Error("打包期间资源发生变化，请重试。");
    }
    fs.writeFileSync(path.join(out, "chapters.json"), serialized, { flag: "wx" });
    return manifest;
  } catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
}

function readVerifiedChapterBundle(bundleDir: string): { manifest: Manifest; verified: Map<string, string> } {
  const source = path.resolve(bundleDir);
  const root = fs.lstatSync(source); if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("章节包目录无效。");
  const manifestPath = path.join(source, "chapters.json"), stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANIFEST) throw new Error("章节包清单无效或过大。");
  const manifest = validateChapterManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const verified = new Map<string, string>();
  for (const chapter of manifest.chapters) for (const entry of chapter.assets) {
    if (verified.has(entry.sha256)) continue;
    const file = regularUnder(source, `assets/${entry.sha256}.blob`), actual = digest(file);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error(`章节包资源校验失败：${entry.path}`);
    verified.set(entry.sha256, file);
  }
  // Equal hashes must always advertise the same byte count.
  for (const chapter of manifest.chapters) for (const entry of chapter.assets) if (fs.statSync(verified.get(entry.sha256)!).size !== entry.bytes) throw new Error("资源大小声明不一致。");
  return { manifest, verified };
}

/** Read-only package inspection validates the same bytes as restoration. */
export function inspectChapterBundle(bundleDir: string) {
  const { manifest } = readVerifiedChapterBundle(bundleDir);
  const unique = new Map<string, number>();
  let expandedBytes = 0, references = 0;
  const chapters = manifest.chapters.map(({ project, assets }) => {
    for (const asset of assets) { references++; expandedBytes += asset.bytes; unique.set(asset.sha256, asset.bytes); }
    return { id: project.id, title: project.title, scenes: project.scenes.length, references: assets.length };
  });
  return { version: manifest.version, chapters, references, uniqueAssets: unique.size, expandedBytes, storedBytes: [...unique.values()].reduce((sum, size) => sum + size, 0) };
}

export function restoreChapterBundle(bundleDir: string, outDir: string): Manifest {
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) throw new Error("目标目录已存在，不会覆盖。");
  const { manifest, verified } = readVerifiedChapterBundle(bundleDir);
  fs.mkdirSync(out);
  try {
    for (const chapter of manifest.chapters) {
      const dir = path.join(out, chapter.project.id); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(chapter.project, null, 2), { flag: "wx" });
      for (const entry of chapter.assets) {
        const dest = path.join(dir, entry.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(verified.get(entry.sha256)!, dest, fs.constants.COPYFILE_EXCL);
        const actual = digest(dest); if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error("恢复期间资源发生变化，请重试。");
      }
    }
    return manifest;
  } catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
}

// --- DRAMA-08 自包含单文件迁移包(内嵌素材,供 Web 导出/导入) -----------------
const PORTABLE_FORMAT = "glint-chapters-portable";
const MAX_PORTABLE_BYTES = 32 * 1024 * 1024;
type PortableEntry = { path: string; sha256: string; bytes: number; data: string };
type PortableManifest = { format: typeof PORTABLE_FORMAT; version: 1; chapters: Array<{ project: SceneScriptProject; assets: PortableEntry[] }> };
const base64Size = (value: string) => { const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0; return Math.floor(value.length * 3 / 4) - padding; };

/** Self-contained single-file bundle: assets are embedded as base64 so a browser
 *  download migrates complete. Cross-chapter identity is enforced on content hash. */
export function buildPortableChapterBundle(inputs: Array<{ project: SceneScriptProject; readAsset: (ref: string) => Buffer }>): PortableManifest {
  if (!inputs.length || inputs.length > MAX_CHAPTERS) throw new Error("章节数必须在 1 到 100 之间。");
  const contents = new Map<string, Buffer>(); let total = 0, count = 0;
  const chapters = inputs.map(input => {
    const project = parseProject(input.project);
    const assets: PortableEntry[] = [];
    for (const ref of referencedAssets(project)) {
      const data = input.readAsset(ref);
      if (!Buffer.isBuffer(data) || !data.length) throw new Error(`素材 ${ref} 缺失或为空。`);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const previous = contents.get(sha256);
      if (previous !== undefined && !previous.equals(data)) throw new Error(`素材 ${ref} 内容与已见哈希冲突，请重试。`);
      contents.set(sha256, data); total += data.length; count++;
      if (count > MAX_REFS || total > MAX_EXPANDED) throw new Error("章节包资源超过限制。");
      assets.push({ path: ref, sha256, bytes: data.length, data: data.toString("base64") });
    }
    return { project, assets };
  });
  const manifest: PortableManifest = { format: PORTABLE_FORMAT, version: 1, chapters };
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_PORTABLE_BYTES) throw new Error("自包含章节包超过 32 MiB；请先压缩或拆分章节。");
  return manifest;
}

const EXTENSION = /\.(png|jpg|webp|mp4|mp3|wav)$/;

/** Restore a portable bundle into a media library. Assets are re-homed under
 *  content-addressed names (library names are flat; chapter refs may nest), and
 *  every returned project has its refs rewritten to the installed names. */
export function restorePortableChapterBundle(input: unknown, installAsset: (data: Buffer, extension: string) => string): Array<{ project: SceneScriptProject; renamed: Record<string, string> }> {
  if (!input || typeof input !== "object") throw new Error("章节迁移包无效。");
  const raw = input as Partial<PortableManifest>;
  if (raw.format !== PORTABLE_FORMAT || raw.version !== 1 || !Array.isArray(raw.chapters) || raw.chapters.length < 1 || raw.chapters.length > MAX_CHAPTERS) throw new Error("章节迁移包格式或数量无效。");
  const installed = new Map<string, string>(); let count = 0, expanded = 0;
  const restored = raw.chapters.map(item => {
    const project = parseProject(item.project);
    if (!Array.isArray(item.assets)) throw new Error("章节迁移包资源清单无效。");
    const rewritten = new Map<string, string>();
    const rewrite = (value: string): string => rewritten.get(value) ?? value;
    for (const entry of item.assets as PortableEntry[]) {
      if (!entry || typeof entry.path !== "string" || !safeRef(entry.path) || typeof entry.data !== "string" || !validHash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_ASSET_BYTES || base64Size(entry.data) !== entry.bytes) throw new Error("章节迁移包资源条目无效。");
      const extension = entry.path.match(EXTENSION)?.[1];
      if (!extension) throw new Error(`迁移包素材类型不受支持：${entry.path}`);
      const data = Buffer.from(entry.data, "base64");
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== entry.sha256 || data.length !== entry.bytes) throw new Error(`迁移包素材校验失败：${entry.path}`);
      let name = installed.get(sha256);
      if (!name) { name = installAsset(data, extension); installed.set(sha256, name); }
      rewritten.set(entry.path, `assets/${name}`);
      count++; expanded += data.length;
      if (count > MAX_REFS || expanded > MAX_EXPANDED) throw new Error("章节迁移包资源超过限制。");
    }
    const refs = referencedAssets(project);
    if (refs.some(ref => !rewritten.has(ref))) throw new Error(`工程 ${project.id} 的资源清单不完整。`);
    const migrated = JSON.parse(JSON.stringify(project)) as SceneScriptProject;
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") return rewrite(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
      return value;
    };
    return { project: walk(migrated) as SceneScriptProject, renamed: Object.fromEntries([...rewritten.entries()].map(([from, to]) => [from, to.slice("assets/".length)])) };
  });
  // 相同内容哈希必须解析到同一个素材名(内容寻址一致性)。
  const identities = new Map<string, string>();
  for (const chapter of restored) for (const [from, to] of Object.entries(chapter.renamed)) {
    const entry = raw.chapters[restored.indexOf(chapter)]?.assets?.find(item => item.path === from);
    if (!entry) continue;
    const previous = identities.get(entry.sha256);
    if (previous !== undefined && previous !== to) throw new Error("素材恢复后名称不一致，请重试。");
    identities.set(entry.sha256, to);
  }
  return restored;
}
