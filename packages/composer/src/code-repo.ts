import fs from "node:fs";
import path from "node:path";
import { ComposerError, composeFromMarkdown, type ComposerOptions } from "./heuristic";
const IGNORED = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "__pycache__"]);
const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".rs", ".go"]);
export interface SurveyOptions extends ComposerOptions { maxDepth?: number }
export interface CodeFile { path: string; symbols: Array<{ name: string; line: number }>; imports: string[]; startLine: number; snippet: string }
function boundedRead(file: string, limit: number) {
  // Never follow symlinks or read oversized files/credentials during a survey.
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return "";
  return fs.readFileSync(file, "utf8");
}
export function surveyCodeRepo(repoPath: string, options: SurveyOptions = {}): { markdown: string; files: CodeFile[]; name: string } {
  const repo = path.resolve(repoPath), maxDepth = options.maxDepth ?? 3;
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new ComposerError(`Repository directory not found: ${repo}`);
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 6) throw new ComposerError("maxDepth must be 0..6");
  let name = path.basename(repo), description = "";
  const dependencies: string[] = [], paths: string[] = [], tree: string[] = [];
  try {
    const pkg = JSON.parse(boundedRead(path.join(repo, "package.json"), 128 * 1024));
    if (typeof pkg.name === "string") name = pkg.name;
    if (typeof pkg.description === "string") description = pkg.description;
    dependencies.push(...Object.keys(pkg.dependencies ?? {}).slice(0, 8));
  } catch { /* A repository does not need package.json. */ }
  let visited = 0;
  function walk(dir: string, depth: number) {
    if (depth > maxDepth || visited >= 400) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited++ >= 400) break;
      if (entry.name.startsWith(".") || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name), relative = path.relative(repo, absolute).split(path.sep).join("/");
      if (tree.length < 40) tree.push(relative + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile() && SOURCE.has(path.extname(entry.name)) && !/lock|secret|credential|password|\.min\./i.test(entry.name)) paths.push(relative);
    }
  }
  walk(repo, 0);
  const priority = (file: string) => /(?:^|\/)(?:index|main|app)\.[^.]+$/i.test(file) ? 0 : 1;
  const files: CodeFile[] = paths.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b)).slice(0, 12).flatMap((relative) => {
    let text = ""; try { text = boundedRead(path.join(repo, relative), 64 * 1024); } catch { return []; }
    if (!text || text.includes("\0")) return [];
    const lines = text.split(/\r?\n/), symbols: CodeFile["symbols"] = [], imports: string[] = [];
    lines.forEach((line, index) => {
      // Static declarations only: these are candidates, not a semantic call graph.
      const match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|def|fn|func|struct|enum)\s+([\w$]+)/.exec(line);
      if (match) symbols.push({ name: match[1]!, line: index + 1 });
      const from = /(?:from\s+["']([^"']+)["']|require\(["']([^"']+)["']\)|import\s+["']([^"']+)["'])/.exec(line);
      const specifier = from?.[1] ?? from?.[2] ?? from?.[3];
      if (specifier && !imports.includes(specifier)) imports.push(specifier);
    });
    const start = Math.max(0, (symbols[0]?.line ?? 1) - 3);
    return [{ path: relative, symbols: symbols.slice(0, 12), imports: imports.slice(0, 8), startLine: start + 1, snippet: lines.slice(start, start + 12).join("\n") }];
  });
  const lines = [`# ${name}`, "", "## 项目简介", description || "以下内容来自本地文件的静态扫描。", "", "## 技术栈", dependencies.length ? dependencies.join("、") : "未发现 package.json 运行时依赖。"];
  for (const file of files.slice(0, 5)) {
    lines.push("", `## ${file.path} · L${file.startLine}`, `文件 ${file.path}。${file.symbols.length ? `声明候选：${file.symbols.slice(0, 3).map((s) => `${s.name}（L${s.line}）`).join("、")}。` : "以下为文件原文摘录。"}`, file.imports.length ? `静态导入：${file.imports.join("、")}。` : "", "```" + path.extname(file.path).slice(1), file.snippet.replace(/```/g, "~~~"), "```");
  }
  lines.push("", "## 目录结构", "扫描最多 400 个目录项；代码摘要只读取最多 12 个、每个不超过 64 KiB 的源文件。", "```text", ...tree, "```");
  for (const filename of ["README.md", "readme.md", "Readme.md"]) {
    try { const readme = boundedRead(path.join(repo, filename), 256 * 1024); if (readme) { lines.push("", "## README 摘录", readme.slice(0, 1000).replace(/^#/gm, "")); break; } } catch { /* Optional. */ }
  }
  return { markdown: lines.join("\n"), files, name };
}
/** Uses actual bounded source snippets; it does not run the app or infer function behavior. */
export function composeFromCodeRepo(repoPath: string, options: SurveyOptions = {}) {
  const survey = surveyCodeRepo(repoPath, options);
  return composeCodeSurvey(survey, options);
}
export function composeCodeSurvey(survey: ReturnType<typeof surveyCodeRepo>, options: SurveyOptions = {}) {
  return composeFromMarkdown(survey.markdown, { ...options, projectId: options.projectId ?? (survey.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "code-survey"), sourceName: "code-survey.md" });
}
