import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "@glintai/buildgraph";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { projectSha256, writeProjectJson } from "./build";
import { readArg } from "./glint-runtime";

export type EditOp = "set_text" | "set_narration" | "set_timing" | "set_chart_value" | "set_theme" | "move_scene";

export const EDIT_OPS: readonly EditOp[] = ["set_text", "set_narration", "set_timing", "set_chart_value", "set_theme", "move_scene"];

export interface SemanticEdit {
  projectPath: string;
  op: EditOp;
  sceneId?: string;
  field?: string;
  value?: unknown;
  value2?: unknown;
  index?: number;
  to?: number;
  expectedRevision?: string;
}

export interface SemanticEditResult {
  projectId: string;
  revision: string;
  op: EditOp;
  changed: string;
}

function fail(message: string): never { throw new Error(message); }

function sceneOf(project: SceneScriptProject, sceneId: string | undefined) {
  if (!sceneId) fail("This edit needs --scene=<id>");
  const index = project.scenes.findIndex(scene => scene.id === sceneId);
  if (index < 0) fail(`Unknown scene: ${sceneId}`);
  return { scene: project.scenes[index]!, index };
}

/**
 * Semantic operations reject anything that is not a real field of the current
 * scene kind, so an agent cannot silently write a key nobody renders.
 */
export function applySemanticEdit(edit: SemanticEdit): SemanticEditResult {
  const projectPath = path.resolve(edit.projectPath);
  if (!EDIT_OPS.includes(edit.op)) fail(`Unknown edit op: ${edit.op}. Supported: ${EDIT_OPS.join(", ")}`);
  const raw = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const current = parseProject(raw);
  const currentRevision = `sha256:${projectSha256(current)}`;
  if (edit.expectedRevision && edit.expectedRevision !== currentRevision) fail(`Revision conflict: expected ${edit.expectedRevision}, found ${currentRevision}. Re-read the project and re-apply.`);
  const project = structuredClone(current);
  let changed = "";

  if (edit.op === "set_theme") {
    if (typeof edit.value !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(edit.value)) fail("set_theme needs a theme id (lowercase kebab-case)");
    project.theme = edit.value;
    changed = "theme";
  } else if (edit.op === "set_text") {
    const { scene, index } = sceneOf(project, edit.sceneId);
    if (typeof edit.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(edit.field)) fail("set_text needs --field=<top-level string field>");
    if (typeof edit.value !== "string") fail("set_text needs a string --value");
    const record = scene as unknown as Record<string, unknown>;
    if (typeof record[edit.field] !== "string") fail(`Scene ${scene.id} (${scene.kind}) has no string field "${edit.field}"`);
    record[edit.field] = edit.value;
    changed = `scenes[${index}].${edit.field}`;
  } else if (edit.op === "set_narration") {
    const { scene, index } = sceneOf(project, edit.sceneId);
    if (typeof edit.value !== "string" || !edit.value.trim()) fail("set_narration needs a non-empty string --value");
    if (edit.value.length > 10_000) fail("Narration is too long");
    scene.narration.text = edit.value;
    // Word timings and synthesized audio no longer match the new text.
    delete scene.narration.durationMs; delete scene.narration.segments; delete scene.narration.audioRef;
    changed = `scenes[${index}].narration.text`;
  } else if (edit.op === "set_timing") {
    const { scene, index } = sceneOf(project, edit.sceneId);
    const duration = typeof edit.value === "number" ? edit.value : Number(edit.value);
    if (!Number.isInteger(duration) || duration < 100 || duration > 600_000) fail("set_timing needs an integer duration in ms (100..600000)");
    scene.narration.durationMs = duration;
    // A new duration invalidates existing word timings and audio alignment.
    delete scene.narration.segments; delete scene.narration.audioRef;
    changed = `scenes[${index}].narration.durationMs`;
  } else if (edit.op === "set_chart_value") {
    const { scene, index } = sceneOf(project, edit.sceneId);
    if (scene.kind !== "chart") fail(`set_chart_value only applies to chart scenes, got ${scene.kind}`);
    if (!Number.isInteger(edit.index) || edit.index! < 0 || edit.index! >= scene.data.length) fail(`--index must be 0..${scene.data.length - 1}`);
    const value = typeof edit.value === "number" ? edit.value : Number(edit.value);
    if (!Number.isFinite(value)) fail("set_chart_value needs a finite number");
    const point = scene.data[edit.index!]!;
    point.value = value;
    if (edit.value2 !== undefined) {
      const second = typeof edit.value2 === "number" ? edit.value2 : Number(edit.value2);
      if (!Number.isFinite(second)) fail("--value2 must be a finite number");
      point.value2 = second;
    }
    changed = `scenes[${index}].data[${edit.index}].value`;
  } else if (edit.op === "move_scene") {
    const { index } = sceneOf(project, edit.sceneId);
    if (!Number.isInteger(edit.to) || edit.to! < 0 || edit.to! >= project.scenes.length) fail(`--to must be 0..${project.scenes.length - 1}`);
    const [moved] = project.scenes.splice(index, 1);
    project.scenes.splice(edit.to!, 0, moved!);
    changed = `scenes[${index}] → scenes[${edit.to}]`;
  }

  const next = parseProject(project);
  return { projectId: next.id, revision: writeProjectJson(projectPath, next), op: edit.op, changed };
}

export interface SceneDiff { id: string; fields: string[]; beforeIndex?: number; afterIndex?: number }
export interface ProjectDiff {
  project: string;
  projectFields: string[];
  added: string[];
  removed: string[];
  moved: { id: string; from: number; to: number }[];
  changed: SceneDiff[];
  identical: boolean;
}

function differingFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => canonicalJson(before[key]) !== canonicalJson(after[key])).sort();
}

/** Scene-level semantic diff: what changed, by scene id and field name. */
export function compareProjects(before: SceneScriptProject, after: SceneScriptProject): ProjectDiff {
  const projectFields = differingFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>).filter(key => key !== "scenes");
  const beforeIds = before.scenes.map(scene => scene.id), afterIds = after.scenes.map(scene => scene.id);
  const added = afterIds.filter(id => !beforeIds.includes(id));
  const removed = beforeIds.filter(id => !afterIds.includes(id));
  const moved = beforeIds.flatMap((id, from) => {
    const to = afterIds.indexOf(id);
    return to >= 0 && to !== from ? [{ id, from, to }] : [];
  });
  const changed: SceneDiff[] = [];
  for (const id of beforeIds) {
    const beforeIndex = beforeIds.indexOf(id), afterIndex = afterIds.indexOf(id);
    if (afterIndex < 0) continue;
    const fields = differingFields(before.scenes[beforeIndex] as unknown as Record<string, unknown>, after.scenes[afterIndex] as unknown as Record<string, unknown>);
    if (fields.length) changed.push({ id, fields, beforeIndex, afterIndex });
  }
  return { project: after.id, projectFields, added, removed, moved, changed, identical: !projectFields.length && !added.length && !removed.length && !moved.length && !changed.length };
}

/** `glint edit --project=p.json --op=set_text --scene=id --field=title --value="…"` */
export function runEdit(args: string[]): SemanticEditResult {
  const projectPath = readArg(args, "project");
  if (!projectPath) fail("edit requires --project=<scenescript.json>");
  const op = readArg(args, "op") as EditOp | undefined;
  if (!op) fail(`edit requires --op=<${EDIT_OPS.join("|")}>`);
  const rawValue = readArg(args, "value");
  const rawValue2 = readArg(args, "value2");
  const parseValue = (raw: string | undefined) => {
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  };
  const result = applySemanticEdit({
    projectPath, op,
    sceneId: readArg(args, "scene"),
    field: readArg(args, "field"),
    value: parseValue(rawValue),
    value2: parseValue(rawValue2),
    index: readArg(args, "index") !== undefined ? Number(readArg(args, "index")) : undefined,
    to: readArg(args, "to") !== undefined ? Number(readArg(args, "to")) : undefined,
    expectedRevision: readArg(args, "revision"),
  });
  console.log(`[glint] ${result.op}: ${result.changed} → ${result.revision}`);
  return result;
}

/** `glint changes --project=new.json --against=old.json [--out=diff.json]` */
export function runChanges(args: string[]): ProjectDiff {
  const projectPath = readArg(args, "project"), against = readArg(args, "against");
  if (!projectPath || !against) fail("changes requires --project=<new> and --against=<old>");
  const after = parseProject(JSON.parse(fs.readFileSync(path.resolve(projectPath), "utf8")));
  const before = parseProject(JSON.parse(fs.readFileSync(path.resolve(against), "utf8")));
  const diff = compareProjects(before, after);
  if (diff.identical) console.log(`[glint] changes: ${after.id} identical`);
  else {
    if (diff.projectFields.length) console.log(`  project: ${diff.projectFields.join(", ")}`);
    if (diff.added.length) console.log(`  added: ${diff.added.join(", ")}`);
    if (diff.removed.length) console.log(`  removed: ${diff.removed.join(", ")}`);
    for (const move of diff.moved) console.log(`  moved: ${move.id} ${move.from} → ${move.to}`);
    for (const scene of diff.changed) console.log(`  changed: ${scene.id} → ${scene.fields.join(", ")}`);
  }
  const out = readArg(args, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(diff, null, 2)); }
  return diff;
}
