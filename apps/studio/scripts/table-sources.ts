import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chartScenesFromTable } from "@glintai/composer";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

export async function tableProject(sources: string[], options: { id?: string; title?: string; language?: string; aspect?: SceneScriptProject["aspect"]; kind?: string; sheet?: string; python?: string } = {}) {
  const files = sources.flatMap(source => fs.statSync(source).isDirectory() ? fs.readdirSync(source).filter(f => /\.(csv|tsv|xlsx)$/i.test(f)).sort().map(f => path.join(source, f)) : [source]);
  if (!files.length || files.length > 32) throw new Error("请选择 1–32 个 CSV/TSV/XLSX 文件");
  const tables: { name: string; text: string; file: string }[] = [];
  for (const file of [...new Set(files.map(f => path.resolve(f)))]) {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error("表格文件超过 8 MiB");
    if (/\.xlsx$/i.test(file)) {
      const text = await new Promise<string>((resolve, reject) => execFile(options.python ?? "python", ["-I", fileURLToPath(new URL("./read-workbook.py", import.meta.url)), file], { windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error("XLSX 读取失败:需要 Python 3,并检查工作簿、缓存公式值及数据大小", { cause: error })) : resolve(stdout)));
      const sheets: { name: string; text: string }[] = JSON.parse(text);
      for (const sheet of sheets.filter(s => !options.sheet || options.sheet.split(",").includes(s.name))) tables.push({ ...sheet, file });
    } else if (/\.(csv|tsv)$/i.test(file)) tables.push({ name: path.basename(file, path.extname(file)), text: fs.readFileSync(file, "utf8"), file });
    else throw new Error(`不支持的数据文件:${path.basename(file)}`);
  }
  if (!tables.length) throw new Error("没有匹配的非空工作表,检查 --sheet=名称");
  const id = options.id ?? (path.basename(files[0]!, path.extname(files[0]!)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table-chart");
  const warnings: string[] = [], scenes: SceneScriptProject["scenes"] = [];
  for (const [i, table] of tables.entries()) {
    const result = chartScenesFromTable(table.text, { title: options.title && tables.length === 1 ? options.title : table.name, kind: options.kind as never, id: tables.length === 1 ? id : `${id}-${i + 1}` });
    scenes.push(...result.scenes); warnings.push(...result.warnings.map(w => `${table.name}: ${w}`));
  }
  return { project: parseProject({ schemaVersion: 1, id, title: options.title ?? tables[0]!.name, language: options.language ?? "zh-CN", aspect: options.aspect ?? "16:9", knowledgeSources: tables.map((table, i) => ({ id: `data-${i + 1}`, kind: "markdown", name: `${path.basename(table.file)} / ${table.name}` })), scenes }), warnings, tables: tables.length };
}
