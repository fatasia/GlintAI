import fs from "node:fs";
import path from "node:path";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { readArg } from "./glint-runtime";

export interface AssetRow {
  id: string;
  kind: string;
  name: string;
  version: string;
  scenes: string[];
  refs: { path: string; exists: boolean }[];
}

export interface AssetReport {
  project: string;
  assets: AssetRow[];
  unreferenced: string[];
  ok: boolean;
}

/** Identity table plus missing-file and unused-identity checks (C13). */
export function assetReport(project: SceneScriptProject, projectDir: string): AssetReport {
  const refsByAsset = new Map<string, string[]>();
  for (const scene of project.scenes) for (const ref of scene.assetRefs ?? []) refsByAsset.set(ref.assetId, [...(refsByAsset.get(ref.assetId) ?? []), scene.id]);
  const assets = (project.assets ?? []).map(asset => ({
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    version: asset.version,
    scenes: refsByAsset.get(asset.id) ?? [],
    refs: (asset.refs ?? []).map(ref => ({ path: ref, exists: fs.existsSync(path.join(projectDir, ref)) })),
  }));
  const unreferenced = assets.filter(asset => asset.scenes.length === 0).map(asset => asset.id);
  const missing = assets.some(asset => asset.refs.some(ref => !ref.exists));
  return { project: project.id, assets, unreferenced, ok: !missing };
}

/** `glint assets --project=p.json [--out=assets.json]` */
export function runAssets(args: string[]): AssetReport {
  const projectPath = readArg(args, "project");
  if (!projectPath) throw new Error("assets requires --project=<scenescript.json>");
  const file = path.resolve(projectPath);
  const project = parseProject(JSON.parse(fs.readFileSync(file, "utf8")));
  const report = assetReport(project, path.dirname(file));
  if (!report.assets.length) console.log("[glint] assets: none declared");
  for (const asset of report.assets) {
    const missing = asset.refs.filter(ref => !ref.exists).map(ref => ref.path);
    console.log(`  ${asset.id} ${asset.kind} v${asset.version} · scenes: ${asset.scenes.join(", ") || "-"}${missing.length ? ` · MISSING: ${missing.join(", ")}` : ""}`);
  }
  if (report.unreferenced.length) console.log(`  unreferenced: ${report.unreferenced.join(", ")}`);
  const out = readArg(args, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2)); }
  if (!report.ok) process.exitCode = 1;
  return report;
}
