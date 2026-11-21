// Portions derived from OpenMotion (nexu-io/openmotion), Apache-2.0. Modifications: content sourced from Glint's own recipes instead of the upstream catalog.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AspectRatio } from "@glintai/scenescript";
import { STYLE_PACKS, type StylePackMeta } from "@glintai/design-tokens";
import type { CreationPack } from "./creation-packs";
import { TEMPLATES, isTemplateId, type SceneTemplate } from "./templates";

/**
 * 模板目录形制:照抄 OpenMotion library/templates/catalog 的 catalog.json + <entry-id>/template.json
 * + 条目指引文档三层结构;条目内容全部来自 Glint 自有配方/结构模板/风格包,不搬上游条目。
 * MotionBrief 是 R-09a(wp/R-09-motion-brief)的分支内联等价 schema,合入后替换为共享定义;见 docs/plan/cards/R-09b.md。
 */
export const MotionBrief = z.object({
  summary: z.string().min(1).max(2000),
  requires: z.string().min(1).max(500).optional(),
  structureId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  aspect: AspectRatio.optional(),
  theme: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  sceneCount: z.number().int().positive().max(200).optional(),
  durationMs: z.number().int().positive().max(600000).optional(),
}).strict();
export type MotionBrief = z.infer<typeof MotionBrief>;

const sourceId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
/** 参数 key 对齐创作包既有输入名(camelCase,如 productName),目录不做改名改写。 */
const paramKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

export const CatalogParam = z.object({
  key: paramKey,
  label: z.string().min(1).max(120),
  type: z.enum(["text", "color", "number"]),
  // 空串默认值表示可选参数(如价格、单位);openmotion 形制中参数必须携带默认值,可为空。
  value: z.string().max(4000),
  maxLength: z.number().int().positive().max(4000).optional(),
}).strict();
export type CatalogParam = z.infer<typeof CatalogParam>;

export const CatalogPreset = z.object({
  label: z.string().min(1).max(120),
  values: z.record(z.string(), z.string()),
}).strict();
export type CatalogPreset = z.infer<typeof CatalogPreset>;

export const CatalogEntry = z
  .object({
    id: z.string().regex(/^(?:recipe|structure|style)-[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1).max(200),
    kind: z.enum(["recipe", "structure", "style"]),
    tags: z.array(z.string().min(1).max(40)).max(24),
    brief: MotionBrief,
    params: z.array(CatalogParam).max(64),
    presets: z.array(CatalogPreset).max(24),
    cover: z.string().max(200).optional(),
    source: z
      .object({ recipeId: sourceId.optional(), structureId: sourceId.optional(), styleId: sourceId.optional() })
      .strict(),
  })
  .strict()
  .refine(entry => Object.values(entry.source).filter(value => value !== undefined).length === 1,
    entry => ({ message: `${entry.id}: source 必须且只能声明 recipeId/structureId/styleId 之一。` }))
  .refine(
    entry =>
      (entry.kind === "recipe" && entry.source.recipeId !== undefined) ||
      (entry.kind === "structure" && entry.source.structureId !== undefined) ||
      (entry.kind === "style" && entry.source.styleId !== undefined),
    entry => ({ message: `${entry.id}: kind 与 source 声明的引用类型不一致。` }),
  )
  .refine(entry => new Set(entry.params.map(param => param.key)).size === entry.params.length,
    entry => ({ message: `${entry.id}: 参数 key 重复。` }))
  .refine(
    entry => entry.presets.every(preset => Object.keys(preset.values).every(key => entry.params.some(param => param.key === key))),
    entry => ({ message: `${entry.id}: 预设引用了未声明的参数 key。` }),
  );
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const CatalogFile = z.object({
  schemaVersion: z.literal(1),
  format: z.literal("glint-template-catalog"),
  counts: z.object({
    recipe: z.number().int().nonnegative(), structure: z.number().int().nonnegative(), style: z.number().int().nonnegative(),
  }).strict(),
  entryIds: z.array(z.string()).min(1),
}).strict();
export type CatalogFile = z.infer<typeof CatalogFile>;

/** recipe-catalog.json(apps/web)的单条配方;目录以数据形式引用,不反向依赖 Web 包。 */
export const RecipeCatalogRecipe = z.object({
  id: sourceId,
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(2000),
  template: z.string().min(1).max(40),
  theme: z.string().min(1).max(80),
  aspect: AspectRatio,
  durationSec: z.number().positive().max(600),
  tags: z.array(z.string().min(1).max(40)).max(24),
  sampleMode: z.literal("source"),
  sample: z.string().min(1).max(4000),
}).strict();
export type RecipeCatalogRecipe = z.infer<typeof RecipeCatalogRecipe>;

export const RecipeCatalogFile = z.object({
  version: z.number().int(),
  generatedAt: z.string().min(1),
  recipes: z.array(RecipeCatalogRecipe).min(1),
}).strict();

export interface CatalogSources {
  packs?: readonly CreationPack[];
  /** recipe-catalog.json 的 recipes 数组;由调用方(CLI)读盘传入,composer 不反向依赖 apps/web。 */
  recipes?: readonly RecipeCatalogRecipe[];
  templates?: readonly SceneTemplate[];
  stylePacks?: readonly StylePackMeta[];
  /** 配方封面图目录(<recipeId>.png);命中时条目声明 cover 并由导入器复制进目录。 */
  recipeCoverDir?: string;
}

const packParams = (pack: CreationPack): CatalogParam[] =>
  pack.inputs.map(slot => ({ key: slot.id, label: slot.label, type: "text", value: slot.defaultValue, maxLength: slot.maxLength }));
const packPreset = (pack: CreationPack): CatalogPreset[] =>
  [{ label: "默认内容", values: Object.fromEntries(pack.inputs.map(slot => [slot.id, slot.defaultValue])) }];

function buildCatalogEntries(sources: CatalogSources): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const pack of sources.packs ?? []) {
    entries.push({
      id: `recipe-${pack.id}`, title: pack.title, kind: "recipe", tags: [...pack.tags],
      brief: { summary: pack.description, aspect: pack.preview.aspect, sceneCount: pack.preview.sceneCount, durationMs: pack.preview.durationMs },
      params: packParams(pack), presets: packPreset(pack),
      source: { recipeId: pack.id },
    });
  }
  for (const recipe of sources.recipes ?? []) {
    const cover = sources.recipeCoverDir && existsSync(path.join(sources.recipeCoverDir, `${recipe.id}.png`))
      ? `recipe-${recipe.id}/cover.png` : undefined;
    entries.push({
      id: `recipe-${recipe.id}`, title: recipe.title, kind: "recipe", tags: [...recipe.tags],
      brief: {
        summary: recipe.description, aspect: recipe.aspect, theme: recipe.theme,
        ...(isTemplateId(recipe.template) ? { structureId: recipe.template } : {}),
        durationMs: Math.round(recipe.durationSec * 1000),
      },
      // 资料类配方的可编辑面是资料文本本身;默认样例即 openmotion 形制中的默认 preset。
      params: [{ key: "source", label: "资料文本", type: "text", value: recipe.sample, maxLength: 4000 }],
      presets: [{ label: "默认样例", values: { source: recipe.sample } }],
      ...(cover ? { cover } : {}),
      source: { recipeId: recipe.id },
    });
  }
  for (const template of sources.templates ?? []) {
    entries.push({
      id: `structure-${template.id}`, title: template.label, kind: "structure", tags: [template.label],
      brief: { summary: template.description, requires: template.requires },
      params: [], presets: [],
      source: { structureId: template.id },
    });
  }
  for (const pack of sources.stylePacks ?? []) {
    entries.push({
      id: `style-${pack.name}`, title: pack.label, kind: "style", tags: [pack.category],
      brief: { summary: pack.summary },
      params: [], presets: [],
      source: { styleId: pack.name },
    });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const seenIds = new Set<string>();
  for (const entry of entries) { if (seenIds.has(entry.id)) throw new Error(`目录条目 ID 冲突:${entry.id}。请检查来源数据是否重名。`); seenIds.add(entry.id); }
  return entries;
}

/** 便捷入口:结构模板与风格包默认取内置目录,配方与创作包由调用方传入。 */
export function buildCatalog(sources: CatalogSources = {}): CatalogEntry[] {
  return buildCatalogEntries({
    ...sources,
    templates: sources.templates ?? TEMPLATES,
    stylePacks: sources.stylePacks ?? STYLE_PACKS,
  });
}

const KIND_LABELS: Record<CatalogEntry["kind"], string> = { recipe: "配方", structure: "结构模板", style: "风格包" };

/** README 是指引不是数据:默认值压成单行摘要,完整值以 template.json 为准。 */
const inline = (value: string): string => { const flat = value.replace(/\s+/g, " ").trim(); return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat; };

function entryReadme(entry: CatalogEntry): string {
  const kind = KIND_LABELS[entry.kind];
  const sourceId = entry.source.recipeId ?? entry.source.structureId ?? entry.source.styleId;
  const params = entry.params.length
    ? entry.params.map(param =>
        `\n- \`${param.key}\`(${param.label},${param.type}${param.maxLength ? `,最长 ${param.maxLength} 字` : ""}):默认 \`${inline(param.value)}\``).join("")
    : "\n- 本条目是引用定义,可编辑参数由使用它的配方声明。";
  const presets = entry.presets.map(preset =>
    `\n- ${preset.label}:${Object.entries(preset.values).map(([key, value]) => `\`${key}=${inline(value)}\``).join("、") || "(空)"}`).join("");
  return `# ${entry.title}

${entry.brief.summary}

- 类型:${kind};来源 ID:\`${sourceId}\`
- 完整数据:同目录 [template.json](template.json)(schema 见 \`packages/composer/src/template-catalog.ts\`)。
- 形制说明:目录条目结构照抄 OpenMotion(nexu-io/openmotion,Apache-2.0);内容来自 Glint 自有配方,不包含上游条目。

## 可编辑参数${params}

## 预设${presets || "\n- (无)"}
`;
}

function catalogIndex(entries: readonly CatalogEntry[]): CatalogFile {
  const count = (kind: CatalogEntry["kind"]) => entries.filter(entry => entry.kind === kind).length;
  return {
    schemaVersion: 1, format: "glint-template-catalog",
    counts: { recipe: count("recipe"), structure: count("structure"), style: count("style") },
    entryIds: entries.map(entry => entry.id),
  };
}

/** 落盘为 openmotion 同形制的三层结构:catalog.json + <id>/template.json + <id>/README.md。内容确定性,无时间戳。 */
export function writeCatalog(dir: string, entries: readonly CatalogEntry[]): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const entryDir = path.join(dir, entry.id);
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(path.join(entryDir, "template.json"), `${JSON.stringify(entry, null, 2)}\n`);
    writeFileSync(path.join(entryDir, "README.md"), entryReadme(entry));
  }
  writeFileSync(path.join(dir, "catalog.json"), `${JSON.stringify(catalogIndex(entries), null, 2)}\n`);
}

const safeRelative = (candidate: string): string | null =>
  candidate && !candidate.includes("\\") && !candidate.includes("\0") && !path.isAbsolute(candidate) &&
  candidate.split("/").every(part => part && part !== "." && part !== "..") ? candidate : null;

export interface CatalogValidation {
  ok: boolean;
  entryCount: number;
  problems: string[];
}

/** 校验已落盘目录:catalog.json 与条目一一对应、每条目过 schema、配方参数非空、cover 路径存在。 */
export function validateCatalog(dir: string): CatalogValidation {
  const problems: string[] = [];
  let parsed: CatalogFile;
  try {
    parsed = CatalogFile.parse(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")));
  } catch (error) {
    return { ok: false, entryCount: 0, problems: [`catalog.json 不可读或不符合 schema:${error instanceof Error ? error.message : String(error)}`] };
  }
  const ids = parsed.entryIds;
  if (new Set(ids).size !== ids.length) problems.push("catalog.json 的 entryIds 有重复。");
  let previousId: string | undefined;
  for (const id of ids) {
    if (previousId !== undefined && previousId > id) problems.push("catalog.json 的 entryIds 未按字典序排列。");
    previousId = id;
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const file = path.join(dir, id, "template.json");
    let entry: CatalogEntry;
    try {
      entry = CatalogEntry.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      problems.push(`${id}/template.json 不可读或不符合 schema:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (entry.id !== id) problems.push(`${id}/template.json 的 id 字段(${entry.id})与目录名不一致。`);
    if (entry.kind === "recipe" && !entry.params.length) problems.push(`${id}: 配方条目必须声明至少一个可编辑参数。`);
    if (entry.cover !== undefined) {
      const cover = safeRelative(entry.cover);
      if (!cover || !cover.startsWith(`${id}/`)) problems.push(`${id}: cover 必须是条目目录内的相对路径。`);
      else {
        const coverFile = path.join(dir, cover);
        if (!existsSync(coverFile) || !statSync(coverFile).isFile()) problems.push(`${id}: cover 文件不存在:${entry.cover}`);
      }
    }
  }
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory() && name.name !== "node_modules" && !seen.has(name.name)) problems.push(`目录 ${name.name} 未在 catalog.json 的 entryIds 中声明。`);
  }
  return { ok: problems.length === 0, entryCount: seen.size, problems };
}

/** 读回已落盘目录;schema 不过或文件缺失直接抛错,供需要"必须成功"的调用方使用。 */
export function readCatalog(dir: string): CatalogEntry[] {
  const catalog = CatalogFile.parse(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")));
  return catalog.entryIds.map(id => {
    const file = path.join(dir, id, "template.json");
    try {
      return CatalogEntry.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`目录条目 ${id}/template.json 不可读或不符合 schema:${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
