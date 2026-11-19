import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseProject } from "./parse";
import type { SceneScriptProject } from "./types";

/**
 * CORE-12 / DELIVER-05 资源包（ADR-010）：工程 + 其引用的全部 assets 文件。
 * 包形态是「目录 + manifest.json」而不是 zip——零新依赖、可审计；跨机迁移用
 * 目录拷贝。manifest 记录每个资源相对路径、sha256 与字节数；缺失资源显式
 * 列出，由调用方决定拒绝还是带缺口打包。
 */
export interface BundleEntry { path: string; sha256: string | null; bytes: number | null; missing?: boolean }
export interface BundlePlan { manifest: { schemaVersion: 1; project: SceneScriptProject; assets: BundleEntry[] }; missingAssets: string[] }

const ASSET_PREFIX = "assets/";

/** Collect every `assets/…` string referenced anywhere in the project document. */
export function referencedAssets(project: SceneScriptProject): string[] {
  parseProject(project);
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (value.startsWith(ASSET_PREFIX) && value.length > ASSET_PREFIX.length && !value.includes("..") && !value.includes("\\")) found.add(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") { for (const child of Object.values(value)) walk(child); }
  };
  walk(project);
  return [...found].sort();
}

export function planBundle(project: SceneScriptProject, projectRoot: string): BundlePlan {
  const assets: BundleEntry[] = [];
  const missingAssets: string[] = [];
  const root = path.resolve(projectRoot);
  for (const ref of referencedAssets(project)) {
    const file = path.resolve(root, ref);
    // Referenced paths are pre-filtered (no "..", no backslash), but a symlink
    // could still point outside the project; resolve and re-check the prefix.
    if (!file.startsWith(root + path.sep)) { missingAssets.push(ref); assets.push({ path: ref, sha256: null, bytes: null, missing: true }); continue; }
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
      assets.push({ path: ref, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"), bytes: stat.size });
    } catch {
      assets.push({ path: ref, sha256: null, bytes: null, missing: true });
      missingAssets.push(ref);
    }
  }
  return { manifest: { schemaVersion: 1, project, assets }, missingAssets };
}

/** Copy the project + referenced assets into a bundle directory; refuses to overwrite. */
export function writeBundle(project: SceneScriptProject, projectRoot: string, outDir: string): BundlePlan {
  if (fs.existsSync(outDir)) throw new Error(`资源包目录已存在：${outDir}；换一个输出目录。`);
  const plan = planBundle(project, projectRoot);
  fs.mkdirSync(path.join(outDir, ASSET_PREFIX), { recursive: true });
  for (const entry of plan.manifest.assets) {
    if (entry.missing) continue;
    fs.mkdirSync(path.dirname(path.join(outDir, entry.path)), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, entry.path), path.join(outDir, entry.path));
  }
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(plan.manifest.project, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, assets: plan.manifest.assets, missingAssets: plan.missingAssets }, null, 2));
  return plan;
}

/** Verify a bundle directory and return the project; verifies every asset hash. */
export function openBundle(bundleDir: string): { project: SceneScriptProject; missingAssets: string[]; hashMismatches: string[] } {
  const manifestFile = path.join(bundleDir, "manifest.json");
  const projectFile = path.join(bundleDir, "project.json");
  for (const file of [manifestFile, projectFile]) if (!fs.existsSync(file)) throw new Error(`资源包缺少 ${path.basename(file)}；确认这是 glint bundle 目录。`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { assets?: BundleEntry[] };
  const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  const root = path.resolve(bundleDir);
  const missingAssets: string[] = [], hashMismatches: string[] = [];
  for (const entry of manifest.assets ?? []) {
    if (typeof entry?.path !== "string" || entry.path.startsWith("/") || entry.path.includes("..") || entry.path.includes("\\")) { hashMismatches.push(String(entry?.path ?? "?")); continue; }
    const file = path.resolve(root, entry.path);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { missingAssets.push(entry.path); continue; }
    if (fs.lstatSync(file).isSymbolicLink()) { missingAssets.push(entry.path); continue; }
    const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (entry.sha256 && sha256 !== entry.sha256) hashMismatches.push(entry.path);
  }
  return { project, missingAssets, hashMismatches };
}
