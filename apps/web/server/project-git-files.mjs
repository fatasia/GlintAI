import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseProject, parseNleProject, parseProjectWorkspace, PROJECT_WORKSPACE_BYTES } from "@glintai/scenescript";

export const LIMITS = Object.freeze({ input: 4 * 1024 * 1024, project: 2 * 1024 * 1024,
  text: 256 * 1024, documents: 64, workspace: PROJECT_WORKSPACE_BYTES, html: 1024 * 1024,
  files: 64 + 100 + 3, version: 5 * 1024 * 1024, output: 12 * 1024 * 1024, pending: 16, processMs: 15000 });
export const MEDIA_POLICY = "保存工程 JSON、剧本文本、设计 HTML（含内嵌图片）、设计元数据与批注、项目固定品牌、关联剪辑时间线和素材引用；不备份共享素材原文件，不复制大素材、机器凭据或导出缓存。外部素材仍由原素材库管理。";
export class ProjectGitError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function demand(value, code, message) { if (!value) throw new ProjectGitError(code, message); }
export const hash = value => createHash("sha256").update(value).digest("hex");
export const repositoryKey = (projectId, kind) => hash(`${projectId}-${kind}`);
export function boundedJson(value, limit = LIMITS.input) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new ProjectGitError("invalid-request", "请求必须是可序列化的 JSON 数据。"); }
  demand(typeof text === "string" && Buffer.byteLength(text) <= limit, "too-large", "工程或剧本文本过大，请拆分后重试。");
  return JSON.parse(text);
}
export function parseSnapshot(kind, value, projectId) {
  let project;
  try { project = kind === "scene" ? parseProject(boundedJson(value, LIMITS.project)) : parseNleProject(boundedJson(value, LIMITS.project)); }
  catch (error) {
    if (error instanceof ProjectGitError) throw error;
    throw new ProjectGitError("invalid-project", "工程格式不正确，请先修复 SceneScript/NLE 工程数据。");
  }
  demand(project.id === projectId, "project-id", "快照的工程 ID 与当前工程不一致。");
  const stack = [project];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, entry] of Object.entries(item)) {
      if (typeof entry === "object") stack.push(entry);
      if (typeof entry === "string" && /^(?:src|.*Src)$/.test(key))
        demand(!/^data:/i.test(entry), "embedded-media", "版本库只保存素材引用，请先将内嵌素材导入素材库。");
    }
  }
  return project;
}
export function parseDocuments(value = []) {
  demand(Array.isArray(value) && value.length <= LIMITS.documents, "invalid-documents", "剧本文档必须是数组，且不超过 64 份。");
  const ids = new Set();
  return value.map(item => {
    demand(item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && !ids.has(item.id)
      && typeof item.title === "string" && item.title.length <= 512 && typeof item.content === "string"
      && !item.content.includes("\0") && Buffer.byteLength(item.content) <= LIMITS.text,
    "invalid-documents", "剧本文档需要唯一 ID、标题和不超过 256KB 的纯文本内容。");
    demand((item.kind === undefined || ["script", "screenplay", "outline", "narration"].includes(item.kind))
      && (item.updatedAt === undefined || Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0),
    "invalid-documents", "剧本文档类型或更新时间无效。");
    ids.add(item.id); return { id: item.id, title: item.title, content: item.content,
      ...(item.kind === undefined ? {} : { kind: item.kind }), ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }) };
  });
}
export function parseWorkspace(value, projectId) {
  try { return parseProjectWorkspace(boundedJson(value, LIMITS.workspace), projectId); }
  catch (error) {
    if (error instanceof ProjectGitError) throw error;
    throw new ProjectGitError("invalid-workspace", "工作区格式不正确，请检查设计、批注、品牌和素材引用。");
  }
}
export const designHtmlFile = (documentId, pageId) => `designs/${hash(documentId)}/${hash(pageId)}.html`;
export function unpackWorkspace(files, projectId) {
  if (!files.has("workspace.json")) return undefined;
  try {
    const metadata = JSON.parse(files.get("workspace.json"));
    const workspace = { ...metadata, designs: { ...metadata.designs, documents: metadata.designs.documents.map(doc => ({
      ...doc, pages: doc.pages.map(page => {
        const { htmlFile, ...rest } = page;
        demand(!Object.hasOwn(page, "html") && typeof doc.id === "string" && typeof page.id === "string"
          && htmlFile === designHtmlFile(doc.id, page.id) && files.has(htmlFile),
        "invalid-workspace", "此版本的设计 HTML 文件缺失或元数据无效。");
        return { ...rest, html: files.get(htmlFile) };
      }),
    })) } };
    return parseWorkspace(workspace, projectId);
  } catch (error) {
    if (error instanceof ProjectGitError) throw error;
    throw new ProjectGitError("invalid-workspace", "此版本的工作区元数据损坏或不完整。");
  }
}
export function mediaInfo(project, workspace) {
  const refs = new Set(), stack = [project,workspace?.timeline?.project];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      if (value && typeof value === "object") stack.push(value);
      if (typeof value === "string" && /^(?:src|.*Src)$/.test(key)) refs.add(value);
    }
  }
  for (const asset of workspace?.assets ?? []) refs.add(asset.url);
  for (const node of workspace?.generation?.canvas.nodes ?? []) if (node.outputAsset) refs.add(node.outputAsset);
  return { mediaRefs: [...refs].sort(), mediaPolicy: MEDIA_POLICY };
}
export function textFiles(project, documents, workspace) {
  const files = new Map([
    ["project.json", `${JSON.stringify(project, null, 2)}\n`],
    ["documents.json", `${JSON.stringify(documents.map(({ content, ...metadata }) => metadata), null, 2)}\n`],
    ...documents.map(item => [`documents/${hash(item.id)}.txt`, item.content]),
  ]);
  if (workspace !== undefined) {
    const metadata = { ...workspace, designs: { ...workspace.designs, documents: workspace.designs.documents.map(doc => ({
      ...doc, pages: doc.pages.map(({ html, ...page }) => {
        const htmlFile = designHtmlFile(doc.id, page.id); files.set(htmlFile, html);
        return { ...page, htmlFile };
      }),
    })) } };
    files.set("workspace.json", `${JSON.stringify(metadata)}\n`);
  }
  validateFiles(files); return files;
}
export const managedFile = file => typeof file === "string" && !/[\r\n]/.test(file)
  && (file === "project.json" || file === "documents.json" || file === "workspace.json"
    || /^documents\/[a-f0-9]{64}\.txt$/.test(file) || /^designs\/[a-f0-9]{64}\/[a-f0-9]{64}\.html$/.test(file));
export const fileLimit = file => file.endsWith(".html") ? LIMITS.html : file.endsWith(".txt") ? LIMITS.text : LIMITS.input;
export function validateFiles(files) {
  demand(files.size <= LIMITS.files && [...files.keys()].every(managedFile), "invalid-version", "版本包含过多文件或非工程文件，已停止操作。");
  let bytes = 0;
  for (const [name, text] of files) {
    const size = Buffer.byteLength(text); bytes += size;
    demand(size <= fileLimit(name) && bytes <= LIMITS.version, "too-large", "版本内容过大，已停止操作。");
  }
}
export async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function directory(file) {
  await mkdir(file, { recursive: true });
  const stat = await lstat(file);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-path", "版本目录不能是链接，请更换本地数据目录。");
}
export async function readText(file, max = LIMITS.input) {
  const stat = await lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max, "unsafe-path", "版本文件为链接或大小异常，已停止操作。");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    demand(current.isFile() && current.ino === stat.ino && current.dev === stat.dev && current.nlink === 1 && current.size <= max,
      "unsafe-path", "版本文件已被替换，请重试。");
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length <= max) {
      const part = await handle.read(bytes, length, max + 1 - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    demand(length <= max, "too-large", "版本文件过大，已停止操作。");
    return bytes.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}
export async function atomicJson(file, value) {
  const temp = path.join(path.dirname(file), `.git-${randomUUID()}.tmp`);
  try { await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export async function checkTree(root, limit = 20000) {
  let count = 0;
  async function visit(file, depth) {
    demand(++count <= limit && depth < 12, "unsafe-path", "版本目录异常庞大，已停止操作。");
    const stat = await lstat(file);
    demand(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), "unsafe-path", "版本目录含外部链接，已停止操作。");
    if (stat.isDirectory()) for await (const item of await opendir(file)) await visit(path.join(file, item.name), depth + 1);
  }
  await visit(root, 0);
}
export async function replaceWork(root, files) {
  const work = path.join(root, "work"), previous = path.join(root, "previous"), staged = path.join(root, `stage-${randomUUID()}`);
  await directory(staged);
  try {
    for (const [name, content] of files) {
      demand(managedFile(name), "unsafe-path", "版本包含非工程文件，已停止操作。");
      await directory(path.dirname(path.join(staged, name)));
      await writeFile(path.join(staged, name), content, { flag: "wx", mode: 0o600 });
    }
    if (await exists(work)) await rename(work, previous);
    try { await rename(staged, work); }
    catch (error) { if (await exists(previous)) await rename(previous, work); throw error; }
    await rm(previous, { recursive: true, force: true });
  } finally { await rm(staged, { recursive: true, force: true }); }
}
export async function recoverWork(root) {
  const work = path.join(root, "work"), previous = path.join(root, "previous");
  if (await exists(previous)) {
    if (!await exists(work)) await rename(previous, work);
    else await rm(previous, { recursive: true });
  }
  for (const name of await readdir(root)) if (/^stage-[a-f0-9-]{36}$/.test(name)) await rm(path.join(root, name), { recursive: true });
}
