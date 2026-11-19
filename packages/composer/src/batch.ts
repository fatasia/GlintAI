import { z } from "zod";
import { parseTable } from "./chart-table";
import { VideoPlan } from "./plan";

/**
 * S07 commercial batch pipeline, independently implemented (the upstream skill
 * is AGPL — behavior only, no code). A product table (CSV/TSV) × a template
 * plan with {{variables}} yields one shootable plan per product.
 */

export const BatchRow = z.object({
  /** Stable product id; duplicates are rejected so outputs never collide. */
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  sellingPoints: z.array(z.string().min(1).max(200)).min(1).max(8),
  assets: z.array(z.string().min(1)).max(12),
  /** Optional per-row image-generation brief (falls back to name + first point). */
  assetPrompt: z.string().max(300).default(""),
});
export type BatchRow = z.infer<typeof BatchRow>;

export interface BatchIssue { row: number; column: string; message: string }

const HEADER_ALIASES: Record<string, "id" | "name" | "sellingPoints" | "assets" | "assetPrompt"> = {
  id: "id", 编号: "id", 商品id: "id",
  name: "name", 商品名: "name", 名称: "name", 品名: "name",
  sellingpoints: "sellingPoints", 卖点: "sellingPoints",
  assets: "assets", 素材: "assets", 素材文件: "assets",
  assetprompt: "assetPrompt", 素材描述: "assetPrompt", 生成描述: "assetPrompt",
};

const splitList = (value: string) => value.split(/[|;；]/).map(item => item.trim()).filter(Boolean);

/**
 * Validate a product table: required headers, required fields, unique ids and
 * (optionally) asset existence. Rows that pass schema are returned normalized;
 * issues never throw, so one bad row cannot block the batch.
 */
export function validateBatchTable(text: string, options: { assetExists?: (asset: string) => boolean } = {}): { rows: BatchRow[]; issues: BatchIssue[] } {
  const table = parseTable(text);
  if (!table.length) return { rows: [], issues: [{ row: 0, column: "header", message: "表格为空" }] };
  const header = table[0]!.map(cell => HEADER_ALIASES[cell.trim().toLowerCase()] ?? cell.trim());
  const missing = (["id", "name", "sellingPoints"] as const).filter(column => !header.includes(column));
  if (missing.length) return { rows: [], issues: [{ row: 0, column: "header", message: `缺少必需列：${missing.join("、")}` }] };
  const rows: BatchRow[] = [], issues: BatchIssue[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2;
    if (!cells.some(Boolean)) return;
    const record: Record<string, string> = {};
    header.forEach((column, cellIndex) => { record[column] = cells[cellIndex]?.trim() ?? ""; });
    const candidate = {
      id: record.id ?? "",
      name: record.name ?? "",
      sellingPoints: splitList(record.sellingPoints ?? ""),
      assets: splitList(record.assets ?? ""),
      assetPrompt: record.assetPrompt ?? "",
    };
    const parsed = BatchRow.safeParse(candidate);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        issues.push({ row: rowNumber, column: String(problem.path[0] ?? ""), message: problem.message });
      }
      return;
    }
    const previous = seen.get(parsed.data.id);
    if (previous !== undefined) {
      issues.push({ row: rowNumber, column: "id", message: `商品 id "${parsed.data.id}" 与第 ${previous} 行重复` });
      return;
    }
    seen.set(parsed.data.id, rowNumber);
    for (const asset of parsed.data.assets) {
      if (options.assetExists && !options.assetExists(asset)) {
        issues.push({ row: rowNumber, column: "assets", message: `素材不存在：${asset}` });
      }
    }
    rows.push(parsed.data);
  });
  return { rows, issues };
}

const substitute = (text: string, row: BatchRow): { text: string; unknown: string[] } => {
  const unknown: string[] = [];
  const replaced = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    const point = key.match(/^(?:卖点|sellingPoint)(\d+)$/i);
    if (point) return row.sellingPoints[Number(point[1]) - 1] ?? "";
    const asset = key.match(/^(?:素材|asset)(\d+)$/i);
    if (asset) return row.assets[Number(asset[1]) - 1] ?? "";
    if (/^(?:name|商品名|名称)$/i.test(key)) return row.name;
    if (/^(?:id|商品id|编号)$/i.test(key)) return row.id;
    unknown.push(rawKey);
    return `{{${rawKey}}}`;
  });
  return { text: replaced, unknown };
};

/**
 * Fill a template plan for one product row. goal/narration/visual of every
 * scene plus title/hook/audience/takeaway are substituted; unknown variables
 * are reported (and left in place) so silent misfilling cannot happen.
 */
export function applyTemplate(template: VideoPlan, row: BatchRow): { plan: VideoPlan; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = BatchRow.parse(row);
  const fill = (text: string, field: string) => {
    const result = substitute(text, parsed);
    for (const key of result.unknown) warnings.push(`${field}：未知变量 {{${key}}}`);
    return result.text;
  };
  const plan = VideoPlan.parse({
    ...template,
    title: fill(template.title, "title"),
    hook: fill(template.hook, "hook"),
    audience: fill(template.audience, "audience"),
    takeaway: fill(template.takeaway, "takeaway"),
    scenes: template.scenes.map((scene, index) => ({
      ...scene,
      goal: fill(scene.goal, `scene ${index + 1} goal`),
      narration: fill(scene.narration, `scene ${index + 1} narration`),
      visual: fill(scene.visual, `scene ${index + 1} visual`),
    })),
  });
  return { plan, warnings };
}

/** Cost basis for a batch trial run; `perSecond` pricing is by rendered seconds, `perCall` by submission. */
export interface BatchPricing { perSecond?: number; perCall?: number; currency?: string; basis?: string }

/**
 * BATCH-03 trial budget: rows × (plan seconds × per-second price + per-call
 * price). Estimates only — the gateway bill stays authoritative, so the result
 * always carries its pricing basis.
 */
export function estimateBatchBudget(rows: ReadonlyArray<{ id: string }>, options: { planSeconds?: number; pricing: BatchPricing }): { rows: number; total: number; perRow: number; currency: string; basis: string } {
  if (!Number.isFinite(options.pricing.perSecond) && !Number.isFinite(options.pricing.perCall)) throw new Error("定价缺失：需要 perSecond 或 perCall 之一（来自网关报价端点）");
  const perRow = (options.planSeconds ?? 0) * (options.pricing.perSecond ?? 0) + (options.pricing.perCall ?? 0);
  return {
    rows: rows.length,
    total: Math.round(perRow * rows.length * 10000) / 10000,
    perRow: Math.round(perRow * 10000) / 10000,
    currency: options.pricing.currency ?? "算力",
    basis: options.pricing.basis ?? "网关报价，实际以账单为准",
  };
}

/** BATCH-04 submission schedule: duplicate keys are dropped once, rows run in capped chunks. */
export function scheduleBatch<T>(items: ReadonlyArray<T>, options: { maxConcurrent: number; keyOf: (item: T) => string }): { chunks: T[][]; duplicates: Array<{ item: T; key: string }> } {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const seen = new Set<string>(), duplicates: Array<{ item: T; key: string }> = [], unique: T[] = [];
  for (const item of items) {
    const key = options.keyOf(item);
    if (seen.has(key)) { duplicates.push({ item, key }); continue; }
    seen.add(key);
    unique.push(item);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < unique.length; index += maxConcurrent) chunks.push(unique.slice(index, index + maxConcurrent));
  return { chunks, duplicates };
}

/**
 * BATCH-05 resume: products whose output already exists (and parses) are done;
 * the rest form the todo list, so a partially failed batch never re-bills
 * finished rows. `isDone` is injected to keep this pure.
 */
export function resumeBatch<T extends { id: string }>(rows: ReadonlyArray<T>, options: { isDone: (row: T) => boolean }): { todo: T[]; done: T[] } {
  const todo: T[] = [], done: T[] = [];
  for (const row of rows) (options.isDone(row) ? done : todo).push(row);
  return { todo, done };
}

/**
 * BATCH executor primitive: run capped chunks with in-chunk concurrency.
 * Chunk boundaries serialize on purpose (quota-friendly); a failed row never
 * aborts the batch — failures come back per item for BATCH-05 resume.
 */
export async function runChunked<T, R>(chunks: ReadonlyArray<ReadonlyArray<T>>, run: (item: T) => Promise<R>): Promise<Array<{ item: T; ok: boolean; value?: R; error?: string }>> {
  const results: Array<{ item: T; ok: boolean; value?: R; error?: string }> = [];
  for (const chunk of chunks) {
    const settled = await Promise.allSettled(chunk.map(item => run(item)));
    settled.forEach((outcome, index) => {
      const item = chunk[index]!;
      if (outcome.status === "fulfilled") results.push({ item, ok: true, value: outcome.value });
      else results.push({ item, ok: false, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    });
  }
  return results;
}

import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

/**
 * Bind resolved batch assets into a composed project: a scene whose visual
 * (or notes) still carries {{素材N}} becomes an image scene pointing at the
 * generated file, keeping its narration. Unmatched placeholders stay text —
 * a missing asset must never silently blank a scene.
 */
export function applyBatchAssets(project: SceneScriptProject, assets: readonly string[], options: { copyAsset?: (file: string) => string } = {}): { project: SceneScriptProject; bound: number } {
  let bound = 0;
  const scenes = project.scenes.map(scene => {
    const visual = "visual" in scene && typeof scene.visual === "string" ? scene.visual : "";
    const haystack = `${visual} ${scene.notes ?? ""}`;
    const match = haystack.match(/\{\{\s*(?:素材|asset)(\d+)\s*\}\}/i);
    if (!match) return scene;
    const file = assets[Number(match[1]) - 1];
    if (!file) return scene;
    const local = options.copyAsset ? options.copyAsset(file) : file.startsWith("assets/") ? file : `assets/${file}`;
    const caption = `${visual} ${scene.notes ?? ""}`.replace(/\{\{\s*[^}]+\s*\}\}/g, "").replace(/\s+/g, " ").trim() || undefined;
    bound += 1;
    const converted = parseProject({
      schemaVersion: project.schemaVersion,
      id: project.id, title: project.title,
      aspect: project.aspect, language: project.language, fps: project.fps,
      knowledgeSources: [], theme: project.theme,
      scenes: [{ ...scene, kind: "image", src: local, ...(caption ? { caption } : {}) }],
    });
    return converted.scenes[0]!;
  });
  return bound ? { project: parseProject({ ...project, scenes }), bound } : { project, bound };
}

const GROUP_MARK = "[卖点]";

/**
 * Scene-group variant (BATCH-02): a run of template scenes whose goal starts
 * with [卖点] expands into one clone per selling point — {{卖点}} becomes the
 * point itself and {{卖点序号}} its 1-based index. Run BEFORE applyTemplate;
 * numeric placeholders ({{卖点1}}) are left for it to fill.
 */
export function expandSceneGroups(template: VideoPlan, row: BatchRow): VideoPlan {
  if (!template.scenes.some(scene => scene.goal.startsWith(GROUP_MARK))) return template;
  const scenes: VideoPlan["scenes"] = [];
  for (const scene of template.scenes) {
    if (!scene.goal.startsWith(GROUP_MARK)) { scenes.push(scene); continue; }
    for (const [index, point] of row.sellingPoints.entries()) {
      const fill = (text: string) => text.replace(/\{\{\s*卖点\s*\}\}/g, point).replace(/\{\{\s*卖点序号\s*\}\}/g, String(index + 1));
      scenes.push({
        ...scene,
        goal: fill(scene.goal.slice(GROUP_MARK.length).trimStart()) || `卖点 ${index + 1}`,
        narration: fill(scene.narration),
        visual: fill(scene.visual),
        seconds: scene.seconds,
      });
    }
  }
  const totalSeconds = scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  return VideoPlan.parse({ ...template, scenes, totalSeconds });
}
