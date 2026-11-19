import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { STYLE_PACKS } from "@glintai/design-tokens";
import { parseProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { readArg } from "./glint-runtime";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonFile = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const writeNew = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const isRegularLocalFile = (file: string) => {
  try { return fs.lstatSync(file).isFile() && path.dirname(fs.realpathSync(file)) === fs.realpathSync(path.dirname(file)); }
  catch { return false; }
};

/** Catalog reports observed bytes separately from any historical manifest digest. */
export function sampleCatalog(root: string) {
  const manifestFile = path.join(root, "manifest.json");
  if (!isRegularLocalFile(manifestFile)) throw new Error("样片清单不可用。");
  const manifest = jsonFile(manifestFile);
  if (!Array.isArray(manifest.entries)) throw new Error("样片清单格式无效。");
  return STYLE_PACKS.map(pack => {
    const matches = manifest.entries.filter((entry: any) => entry?.id === pack.name);
    if (matches.length !== 1) return { id: pack.name, label: pack.label, status: "unavailable", reason: "清单缺失或重复" };
    const entry = matches[0];
    // Use the known theme ID, never untrusted manifest paths.
    const video = path.join(root, `${pack.name}.mp4`);
    const project = path.join(root, `${pack.name}.project.json`);
    if (entry.status !== "done" || !isRegularLocalFile(video) || !isRegularLocalFile(project)) return { id: pack.name, label: pack.label, status: "unavailable", reason: "样片或工程缺失，或渲染未完成" };
    let actual: string;
    try {
      const bytes = fs.readFileSync(video);
      const sample = parseProject(jsonFile(project));
      if (!bytes.length || sample.theme !== pack.name || !sample.scenes.length) throw new Error("invalid sample");
      actual = hash(bytes);
    } catch {
      return { id: pack.name, label: pack.label, status: "unavailable", reason: "样片不可读、为空，或工程无效 / 主题不匹配" };
    }
    const expected = typeof entry.sha256 === "string" ? entry.sha256 : null;
    return { id: pack.name, label: pack.label, status: expected && actual !== expected ? "mismatch" : "available", video, project,
      sha256: actual, recordedSha256: expected, integrity: expected ? (actual === expected ? "matched" : "mismatch") : "not-recorded",
      recordedAt: typeof entry.startedAt === "string" ? entry.startedAt : null, renderer: entry.renderer ?? null,
      note: "历史无声草稿；校验仅针对文件，不代表当前主题、字体或跨机像素一致。" };
  });
}

type Payload = { version: 1; id: string; projectId: string; capturedAt: string; sourceSha256: string; themePresent: boolean; theme: unknown };
type Archive = { payload: Payload; sha256: string };

export function archiveTheme(projectFile: string, dir: string): string {
  return archiveThemeBytes(fs.readFileSync(projectFile), dir);
}

/** Archive the original JSON bytes without rewriting or normalizing project fields. */
export function archiveThemeBytes(bytes: Buffer, dir: string): string {
  const source = JSON.parse(bytes.toString("utf8"));
  const parsed = parseProject(source);
  const present = Object.hasOwn(source, "theme");
  const payload: Payload = { version: 1, id: randomUUID(), projectId: parsed.id, capturedAt: new Date().toISOString(), sourceSha256: hash(bytes), themePresent: present, theme: present ? source.theme : null };
  const archive: Archive = { payload, sha256: hash(canonicalJson(payload)) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${payload.id}.style-history.json`);
  writeNew(file, archive);
  return file;
}

export function readArchive(file: string): Archive {
  if (!isRegularLocalFile(file)) throw new Error("主题归档不可用；未修改工程。");
  const value = jsonFile(file);
  const p = value?.payload;
  if (!object(value) || !object(p) || p.version !== 1 || typeof p.id !== "string" || typeof p.projectId !== "string" || !p.projectId || typeof p.capturedAt !== "string" || typeof p.sourceSha256 !== "string" || typeof p.themePresent !== "boolean" || !Object.hasOwn(p, "theme") || (!p.themePresent && p.theme !== null) || typeof value.sha256 !== "string" || hash(canonicalJson(p)) !== value.sha256) throw new Error("主题归档格式不支持或校验失败；未修改工程。");
  return value as Archive;
}

export function listArchives(dir: string, projectId?: string) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith(".style-history.json")).sort().map(name => {
    const file = path.join(dir, name);
    try {
      const archive = readArchive(file);
      return { file, status: "valid", ...archive.payload, sha256: archive.sha256 };
    } catch { return { file, status: "invalid" }; }
  }).filter(entry => !("projectId" in entry) || !projectId || entry.projectId === projectId);
}

export function restoreTheme(projectFile: string, archiveFile: string, output: string): void {
  const archive = readArchive(archiveFile);
  const source = jsonFile(projectFile);
  const parsed = parseProject(source);
  if (parsed.id !== archive.payload.projectId) throw new Error("归档所属工程 ID 不匹配；未修改工程。");
  if (archive.payload.themePresent) source.theme = structuredClone(archive.payload.theme);
  else delete source.theme;
  parseProject(source); // Validate without normalizing or stripping future fields.
  writeNew(output, source);
}

export function runStyleCatalog(args: string[], defaultSampleDir: string): void {
  const action = args[0];
  const dir = readArg(args, "dir");
  const project = readArg(args, "project");
  if (action === "samples") {
    const entries = sampleCatalog(dir ?? defaultSampleDir);
    console.log(JSON.stringify({ version: 1, entries }, null, 2));
    if (entries.some(entry => entry.status !== "available")) process.exitCode = 1;
  } else if (action === "archive") {
    if (!project || !dir) throw new Error("archive 需要 --project=<工程> --dir=<历史目录>。");
    console.log(archiveTheme(project, dir));
  } else if (action === "list") {
    if (!dir) throw new Error("list 需要 --dir=<历史目录>；可选 --id=<工程ID>。");
    const entries = listArchives(dir, readArg(args, "id"));
    console.log(JSON.stringify(entries, null, 2));
    if (entries.some(entry => entry.status === "invalid")) process.exitCode = 1;
  } else if (action === "restore") {
    const archive = readArg(args, "source"), out = readArg(args, "out");
    if (!project || !archive || !out) throw new Error("restore 需要 --project=<工程> --source=<归档> --out=<新工程>。");
    restoreTheme(project, archive, out);
    console.log(`已导出新工程：${out}；原工程未覆盖。`);
  } else throw new Error("用法：glint style-catalog samples|archive|list|restore；历史只保存原始主题，不冻结字体或渲染器。");
}
