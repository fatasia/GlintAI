// Portions derived from OpenMotion (nexu-io/openmotion), Apache-2.0. Modifications: content sourced from Glint's own recipes instead of the upstream catalog.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, validateCatalog, writeCatalog, RecipeCatalogFile } from "@glintai/composer/template-catalog";
import { listCreationPacks } from "@glintai/composer/creation-packs";
import { readArg } from "./glint-runtime";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const recipeCatalogFile = path.resolve(scriptDir, "../../web/src/recipe-catalog.json");
const recipeCoverDir = path.resolve(scriptDir, "../../web/public/recipes");

/** glint catalog-import / catalog-check:既有配方落盘为 OpenMotion 同形制目录,并校验。 */
export function runCatalogCli(args: string[], mode: "import" | "check"): void {
  if (mode === "check") {
    const dir = readArg(args, "dir");
    if (!dir) throw new Error("catalog-check 需要 --dir=<目录>。先用 glint catalog-import --out=<新目录> 生成。");
    if (!fs.existsSync(dir)) throw new Error(`目录不存在:${dir}`);
    const report = validateCatalog(dir);
    for (const problem of report.problems) console.error(`[catalog-check] ${problem}`);
    console.log(`[glint] catalog-check:${report.entryCount} 条目,${report.problems.length} 个问题,结果 ${report.ok ? "通过" : "不通过"}。`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const out = readArg(args, "out");
  if (!out) throw new Error("catalog-import 需要 --out=<新目录>。已存在的目录不会被覆盖。");
  if (fs.existsSync(out)) throw new Error(`输出目录已存在,不覆盖:${out}。请换一个新目录。`);
  const recipes = RecipeCatalogFile.parse(JSON.parse(fs.readFileSync(recipeCatalogFile, "utf8"))).recipes;
  const entries = buildCatalog({ packs: listCreationPacks(), recipes, recipeCoverDir });
  writeCatalog(out, entries);
  let covers = 0;
  for (const entry of entries) {
    if (!entry.cover) continue;
    fs.copyFileSync(path.join(recipeCoverDir, `${entry.source.recipeId}.png`), path.join(out, entry.cover));
    covers++;
  }
  const counts = entries.reduce((tally, entry) => ({ ...tally, [entry.kind]: (tally[entry.kind] ?? 0) + 1 }), {} as Record<string, number>);
  console.log(`[glint] catalog-import:${entries.length} 条目(配方 ${counts.recipe}、结构 ${counts.structure}、风格 ${counts.style}),封面 ${covers} 张 → ${out}`);
  console.log("        形制照抄 OpenMotion(nexu-io/openmotion,Apache-2.0);内容为 Glint 自有配方。校验:glint catalog-check --dir=<目录>");
}
