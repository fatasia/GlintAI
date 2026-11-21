// Portions derived from OpenMotion (nexu-io/openmotion), Apache-2.0. Modifications: content sourced from Glint's own recipes instead of the upstream catalog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STYLE_PACKS } from "@glintai/design-tokens";
import { listCreationPacks } from "./creation-packs";
import { TEMPLATES } from "./templates";
import {
  buildCatalog, CatalogBrief, CatalogEntry, CatalogFile, readCatalog, RecipeCatalogFile,
  validateCatalog, writeCatalog, type CatalogEntry as CatalogEntryType,
} from "./template-catalog";

const recipes = RecipeCatalogFile.parse({
  version: 1, generatedAt: "2026-10-23T00:00:00.000Z",
  recipes: [
    { id: "demo-explainer-dark", title: "示例讲解 · 深色", category: "产品", description: "一段资料变成讲解短片。", template: "explainer", theme: "glint-dark", aspect: "16:9", durationSec: 15, tags: ["讲解", "示例"], sampleMode: "source", sample: "# 示例\n\n## 要点\n- 第一条" },
    { id: "demo-vertical-social", title: "竖屏 示例", category: "产品", description: "竖屏版示例。", template: "not-a-structure", theme: "glint-light", aspect: "9:16", durationSec: 12.5, tags: ["竖屏"], sampleMode: "source", sample: "竖屏样例文本" },
  ],
}).recipes;

/** 先构造裸对象,非法形状用 safeParse 断言;合法形状由用例显式 parse。 */
function entryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "recipe-demo-pack", title: "示例配方", kind: "recipe", tags: ["示例"],
    brief: { summary: "可编辑示例配方。", aspect: "16:9", durationMs: 4000 },
    params: [{ key: "title", label: "标题", type: "text", value: "默认标题", maxLength: 40 }],
    presets: [{ label: "默认内容", values: { title: "默认标题" } }],
    source: { recipeId: "demo-pack" },
    ...overrides,
  };
}
const onlyRecipes = { packs: [], templates: [], stylePacks: [] };
const written = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-template-catalog-"));
  return dir;
};

describe("buildCatalog from real Glint sources", () => {
  const entries = buildCatalog({ packs: listCreationPacks() });

  it("generates more than ten entries from the real creation packs plus built-in structures and styles", () => {
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expect(entries.filter(entry => entry.kind === "recipe").length).toBe(listCreationPacks().length);
    expect(entries.filter(entry => entry.kind === "structure").map(entry => entry.id))
      .toEqual(TEMPLATES.map(template => `structure-${template.id}`).sort((a, b) => a.localeCompare(b)));
    expect(entries.filter(entry => entry.kind === "style").map(entry => entry.id))
      .toEqual(STYLE_PACKS.map(pack => `style-${pack.name}`).sort((a, b) => a.localeCompare(b)));
  });

  it("keeps ids unique, sorted, and consistent with the source reference", () => {
    const ids = entries.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    for (const entry of entries) {
      expect(Object.values(entry.source).filter(value => value !== undefined).length).toBe(1);
      expect(CatalogEntry.safeParse(entry).success).toBe(true);
    }
  });

  it("gives every pack recipe at least one editable param and a default preset matching the inputs", () => {
    for (const pack of listCreationPacks()) {
      const entry = entries.find(candidate => candidate.id === `recipe-${pack.id}`)!;
      expect(entry.params.map(param => param.key)).toEqual(pack.inputs.map(slot => slot.id));
      expect(entry.presets[0]?.values).toEqual(Object.fromEntries(pack.inputs.map(slot => [slot.id, slot.defaultValue])));
    }
  });

  it("describes structures and styles as reference definitions without fabricated params", () => {
    const structure = entries.find(entry => entry.id === "structure-explainer")!;
    expect(structure.brief.summary).toBe(TEMPLATES.find(template => template.id === "explainer")!.description);
    expect(structure.brief.requires).toBeTruthy();
    expect(structure.params).toEqual([]);
    const style = entries.find(entry => entry.id === "style-glint-dark")!;
    expect(style.brief.summary).toContain("深底");
    expect(style.source.styleId).toBe("glint-dark");
  });

  it("maps recipe catalog entries to source-text params and only links known structures", () => {
    const built = buildCatalog({ packs: [], recipes });
    const explainer = built.find(entry => entry.id === "recipe-demo-explainer-dark")!;
    expect(explainer.brief.structureId).toBe("explainer");
    expect(explainer.brief.durationMs).toBe(15000);
    expect(explainer.params[0]).toMatchObject({ key: "source", value: "# 示例\n\n## 要点\n- 第一条", maxLength: 4000 });
    const vertical = built.find(entry => entry.id === "recipe-demo-vertical-social")!;
    expect(vertical.brief.structureId).toBeUndefined();
    expect(vertical.brief.aspect).toBe("9:16");
    expect(vertical.brief.durationMs).toBe(12500);
  });

  it("declares covers only when the cover file exists, as paths inside the entry directory", () => {
    const coverDir = written();
    fs.writeFileSync(path.join(coverDir, "demo-explainer-dark.png"), "png");
    const withCover = buildCatalog({ packs: [], recipes, recipeCoverDir: coverDir });
    expect(withCover.find(entry => entry.id === "recipe-demo-explainer-dark")!.cover).toBe("recipe-demo-explainer-dark/cover.png");
    expect(withCover.find(entry => entry.id === "recipe-demo-vertical-social")!.cover).toBeUndefined();
    const withoutCover = buildCatalog({ packs: [], recipes });
    expect(withoutCover.every(entry => entry.cover === undefined)).toBe(true);
  });

  it("rejects duplicate ids across sources instead of silently merging them", () => {
    const clash = listCreationPacks().map(pack => ({ ...pack, id: "demo-explainer-dark" }));
    expect(() => buildCatalog({ packs: clash, recipes })).toThrow("目录条目 ID 冲突:recipe-demo-explainer-dark");
  });
});

describe("catalog round trip and validation", () => {
  it("writes an OpenMotion-shaped catalog that reads back identically, deterministically", () => {
    const entries = buildCatalog({ packs: listCreationPacks(), recipes });
    const dir = written();
    writeCatalog(dir, entries);
    expect(readCatalog(dir)).toEqual(entries);
    const catalog = CatalogFile.parse(JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8")));
    expect(catalog).toMatchObject({
      schemaVersion: 1, format: "glint-template-catalog",
      counts: { recipe: listCreationPacks().length + recipes.length, structure: TEMPLATES.length, style: STYLE_PACKS.length },
    });
    expect(catalog.entryIds).toEqual(entries.map(entry => entry.id));
    for (const entry of entries) {
      expect(fs.existsSync(path.join(dir, entry.id, "template.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, entry.id, "README.md"))).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, "recipe-demo-explainer-dark", "README.md"), "utf8")).toContain("OpenMotion");
    const again = written();
    writeCatalog(again, entries);
    expect(fs.readFileSync(path.join(again, "catalog.json"))).toEqual(fs.readFileSync(path.join(dir, "catalog.json")));
  });

  it("validates a freshly written catalog without problems", () => {
    const dir = written();
    writeCatalog(dir, buildCatalog({ packs: listCreationPacks(), recipes }));
    expect(validateCatalog(dir)).toMatchObject({ ok: true, problems: [] });
  });

  it("reports a recipe entry with empty params instead of accepting it", () => {
    const dir = written();
    const entries = buildCatalog({ packs: listCreationPacks(), recipes }).map(entry =>
      entry.id === "recipe-demo-explainer-dark" ? { ...entry, params: [], presets: [] } : entry);
    writeCatalog(dir, entries);
    const report = validateCatalog(dir);
    expect(report.ok).toBe(false);
    expect(report.problems.some(problem => problem.includes("recipe-demo-explainer-dark") && problem.includes("至少一个可编辑参数"))).toBe(true);
  });

  it("reports missing and escaping cover paths", () => {
    const dir = written();
    const entries = buildCatalog({ packs: [], recipes, templates: [], stylePacks: [] }).map(entry =>
      entry.id === "recipe-demo-explainer-dark" ? { ...entry, cover: "recipe-demo-explainer-dark/cover.png" } : entry);
    entries.push(entryFixture({ id: "recipe-escape-cover", source: { recipeId: "escape-cover" }, cover: "../outside.png" }) as unknown as CatalogEntryType);
    writeCatalog(dir, entries);
    const report = validateCatalog(dir);
    expect(report.problems.some(problem => problem.includes("recipe-demo-explainer-dark") && problem.includes("cover 文件不存在"))).toBe(true);
    expect(report.problems.some(problem => problem.startsWith("recipe-escape-cover"))).toBe(true);
  });

  it("reports corrupted, mismatched and undeclared entry directories", () => {
    const entries = buildCatalog({ packs: [], recipes, templates: [], stylePacks: [] });
    const dir = written();
    writeCatalog(dir, entries);
    fs.writeFileSync(path.join(dir, "recipe-demo-vertical-social", "template.json"), "{ not json");
    const mismatched = entries.find(entry => entry.id === "recipe-demo-explainer-dark")!;
    fs.writeFileSync(path.join(dir, "recipe-demo-explainer-dark", "template.json"),
      JSON.stringify({ ...mismatched, id: "recipe-other-id" }, null, 2));
    fs.mkdirSync(path.join(dir, "structure-undeclared"));
    const report = validateCatalog(dir);
    expect(report.ok).toBe(false);
    expect(report.problems.some(problem => problem.startsWith("recipe-demo-vertical-social/template.json 不可读"))).toBe(true);
    expect(report.problems.some(problem => problem.includes("与目录名不一致"))).toBe(true);
    expect(report.problems.some(problem => problem.includes("structure-undeclared"))).toBe(true);
    expect(report.entryCount).toBe(recipes.length);
  });

  it("fails closed when catalog.json itself is invalid", () => {
    const dir = written();
    writeCatalog(dir, buildCatalog({ packs: [], recipes }));
    fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ schemaVersion: 2, format: "glint-template-catalog", counts: {}, entryIds: [] }));
    const report = validateCatalog(dir);
    expect(report.ok).toBe(false);
    expect(report.entryCount).toBe(0);
    expect(report.problems[0]).toContain("catalog.json");
  });

  it("throws an actionable error when readCatalog hits a missing entry file", () => {
    const dir = written();
    writeCatalog(dir, buildCatalog({ packs: [], recipes }));
    fs.rmSync(path.join(dir, "recipe-demo-vertical-social"), { recursive: true });
    expect(() => readCatalog(dir)).toThrow(/recipe-demo-vertical-social\/template\.json/);
  });
});

describe("schema rejections", () => {
  it("rejects unknown kinds, extra fields and kind/source mismatches", () => {
    expect(CatalogEntry.safeParse({ ...entryFixture(), kind: "theme" }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...entryFixture(), extra: true }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...entryFixture(), source: { recipeId: "a", styleId: "b" } }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...entryFixture(), kind: "style" }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...entryFixture(), id: "recipe-UPPER" }).success).toBe(false);
  });

  it("rejects briefs without a summary and presets referencing undeclared params", () => {
    expect(CatalogBrief.safeParse({ summary: "" }).success).toBe(false);
    expect(CatalogBrief.safeParse({}).success).toBe(false);
    expect(CatalogEntry.safeParse(entryFixture({ presets: [{ label: "空引用", values: { missing: "x" } }] })).success).toBe(false);
    expect(CatalogEntry.safeParse(entryFixture({ params: [
      { key: "title", label: "标题", type: "text", value: "a", maxLength: 40 },
      { key: "title", label: "重复", type: "text", value: "b" },
    ] })).success).toBe(false);
  });

  it("rejects recipe catalog rows that do not match the real catalog shape", () => {
    expect(RecipeCatalogFile.safeParse({ version: 1, generatedAt: "x", recipes: [{ ...recipes[0], sampleMode: "url" }] }).success).toBe(false);
    expect(RecipeCatalogFile.safeParse({ version: 1, generatedAt: "x", recipes: [{ ...recipes[0], aspect: "4:3" }] }).success).toBe(false);
    expect(RecipeCatalogFile.safeParse({ version: 1, generatedAt: "x", recipes: [] }).success).toBe(false);
  });
});
