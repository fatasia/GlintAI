import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { createCliRuntime, readArg, renderArgs, sourceInput } from "./glint-runtime";
import { composeFromSource, isTemplateId, reviewProject } from "@glintai/composer";
import { llmFromEnvironment } from "@glintai/llm";
import { defaultPersonas, reexplain, rehearse, parsePersonaPack } from "@glintai/listener";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { commandSourceAdapter, officeSourceAdapters, mediaSourceAdapters, readSourceText, type SourceAdapter } from "@glintai/knowledge";

/**
 * Unified Glint CLI — the single entry both the apps and the agent skill drive.
 *
 *   pnpm glint make --source=doc.md              # 一次出片(离线合成+Edge配音+配乐)
 *   pnpm glint make --idea="解释复利" --engine=llm --polish
 *   pnpm glint make --code=../some-repo
 *   pnpm glint ask --q="..."
 *   pnpm glint rehearse / reexplain / render ...
 */
const runtime = createCliRuntime(import.meta.url);
const STUDIO_DIR = runtime.studioDir;
const { resolvePaths, runScript } = runtime;

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function requireLlm() {
  if (!process.env.GLINT_LLM_API_KEY) {
    throw new Error(
      "This command needs an LLM. Set GLINT_LLM_API_KEY (GLINT_LLM_BASE_URL / GLINT_LLM_MODEL optional).",
    );
  }
  return llmFromEnvironment();
}

async function runMake(args: string[]): Promise<void> {
  const input = sourceInput(args);
  const engine = readArg(args, "engine") ?? (input.idea ? "llm" : "heuristic");
  if (!["llm", "heuristic"].includes(engine)) throw new Error("Invalid engine");
  const useLlm = engine === "llm" || Boolean(readArg(args, "engine") === "llm");
  const llm = engine === "llm" ? requireLlm() : process.env.GLINT_LLM_API_KEY ? requireLlm() : undefined;

  console.log("[glint] 1/4 composing...");
  const adapters: Record<string, SourceAdapter> = hasFlag(args, "office") ? officeSourceAdapters() : {};
  if(readArg(args,"media-python"))Object.assign(adapters,mediaSourceAdapters({python:readArg(args,"media-python")!,modelDir:readArg(args,"transcription-model")}));
  const adapterPath = readArg(args, "adapters");
  if (adapterPath) {
    const config = JSON.parse(fs.readFileSync(adapterPath, "utf8"));
    for (const [ext, entry] of Object.entries(config) as [string, { command: string; args?: string[] }][]) {
      if (!/^[a-z0-9]+$/.test(ext) || !entry || typeof entry.command !== "string" || (entry.args !== undefined && !Array.isArray(entry.args))) throw new Error("Invalid adapter configuration");
      adapters[ext] = commandSourceAdapter(entry.command, entry.args);
    }
  }
  const composed = await composeFromSource(input, llm, {
    projectId: readArg(args, "id"),
    title: readArg(args, "title"),
    language: readArg(args, "language"),
    aspect: readArg(args, "aspect") as SceneScriptProject["aspect"] | undefined,
    maxScenes: readArg(args, "max-scenes") !== undefined ? Number(readArg(args, "max-scenes")) : undefined,
    fps: readArg(args, "fps") !== undefined ? Number(readArg(args, "fps")) : undefined,
    template: (() => {
      const value = readArg(args, "template");
      if (value !== undefined && !isTemplateId(value)) throw new Error(`Unknown template: ${value}`);
      return isTemplateId(value) ? value : undefined;
    })(),
    theme: readArg(args, "theme"),
    useLlm,
  }, { adapters });
  let project = composed.project;
  const outDir = path.resolve(STUDIO_DIR, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const sourcePath = path.join(outDir, `${project.id}.source.md`);
  fs.writeFileSync(sourcePath, composed.sourceText);
  console.log(`[glint]    project "${project.title}" — ${project.scenes.length} scenes → ${sourcePath}`);

  if ((hasFlag(args, "rehearse") || hasFlag(args, "polish")) && !llm) throw new Error("Rehearsal requires a configured LLM.");
  if ((hasFlag(args, "rehearse") || hasFlag(args, "polish")) && llm) {
    console.log("[glint] 2/4 rehearsal (virtual listeners)...");
    const reports = await rehearse(project, llm, {
      personas: readArg(args, "persona-pack") ? parsePersonaPack(JSON.parse(fs.readFileSync(readArg(args, "persona-pack")!, "utf8"))) : defaultPersonas(project.language),
      timeoutMs: 150_000,
    });
    for (const report of reports) {
      console.log(`  ◆ ${report.persona.name}`);
      for (const confusion of report.confusions) {
        console.log(`    [${confusion.sceneId}] ${confusion.confusion}`);
      }
    }
    const reportPath = path.join(outDir, `${project.id}.rehearsal.json`);
    fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));

    if (hasFlag(args, "polish")) {
      const actionable = reports
        .flatMap((report) => report.confusions)
        .filter((confusion) => confusion.sceneId !== "general")
        .slice(0, 2);
      for (const [index, confusion] of actionable.entries()) {
        console.log(`[glint] 3/4 re-explaining (${index + 1}/${actionable.length}): ${confusion.sceneId}`);
        project = await reexplain(project, llm, {
          sceneId: confusion.sceneId,
          confusion: confusion.confusion,
          timeoutMs: 150_000,
        });
      }
    }
  }

  const projectPath = path.join(outDir, `${project.id}.project.json`);
  fs.writeFileSync(path.join(outDir, `${project.id}.quality.json`), JSON.stringify(reviewProject(project, composed.sourceText), null, 2));
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
  console.log(`[glint] 4/4 rendering...`);
  await runScript("render", renderArgs(projectPath, args));
  console.log(`[glint] make done — "${project.title}"`);
}

async function main(): Promise<void> {
  const [command, ...raw] = process.argv.slice(2);
  const rest = resolvePaths(raw);
  switch (command) {
    case "make":
      return runMake(rest);
    case "check": {
      const projectFile = readArg(rest, "project"), sourceFile = readArg(rest, "source");
      if (!projectFile || !sourceFile) throw new Error("check requires --project= and --source=");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const source = await readSourceText(/^https?:\/\//i.test(sourceFile) ? { url: sourceFile } : { path: sourceFile });
      const report = reviewProject(project, source);
      const output = readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", `${project.id}.quality.json`);
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`[glint] ${report.flagged}/${report.sentences.length} sentences need review → ${output}`);
      if (hasFlag(rest, "strict") && report.flagged) process.exitCode = 1;
      return;
    }
    case "templates": {
      const { TEMPLATES } = await import("@glintai/composer");
      for (const template of TEMPLATES) {
        console.log(`${template.id.padEnd(10)} ${template.label} — ${template.description}`);
      }
      console.log("\n主题: glint-dark | glint-light | cream-editorial | mint-clean | bold-poster");
      return;
    }
    case "render":
      return runScript("render", rest);
    case "media":
      return runScript("media", rest);
    case "render-worker":
      return runScript("render-worker", rest);
    case "preview-code":
      return runScript("preview-code",rest);
    case "code-graph": {
      const root=readArg(rest,"code");if(!root)throw new Error("code-graph requires --code=<repository>");
      const {analyzeCodeRepo}=await import("@glintai/composer");const graph=analyzeCodeRepo(root);
      const out=readArg(rest,"out")??path.join(STUDIO_DIR,"out","code-graph.json");
      fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(graph,null,2));
      console.log(`[glint] ${graph.nodes.length} nodes, ${graph.edges.length} resolved calls, ${graph.unresolved.length} unresolved → ${out}`);return;
    }
    case "personas": {
      const {PERSONA_CATALOG,parsePersonaCatalog}=await import("@glintai/listener/catalog");
      const location=readArg(rest,"catalog");
      if(location && /^https?:/.test(location) && !location.startsWith("https://"))throw new Error("Remote catalogs require HTTPS");
      const text=location?await readSourceText(location.startsWith("https://")?{url:location}:{path:location},{timeoutMs:15_000,httpsOnly:true}):JSON.stringify(PERSONA_CATALOG);
      if(Buffer.byteLength(text)>1024*1024)throw new Error("Catalog exceeds 1 MiB");
      const catalog=parsePersonaCatalog(JSON.parse(text)), id=readArg(rest,"install");
      for(const entry of catalog.entries){
        const pack={version:1,personas:entry.personas}, digest=createHash("sha256").update(JSON.stringify(pack)).digest("hex");
        if(!id)console.log(`${entry.id} ${entry.version} ${entry.license} ${entry.title}\n  ${entry.description}\n  sha256=${digest}`);
        else if(entry.id===id){
          if(readArg(rest,"sha256")!==digest)throw new Error("Review the catalog and pass its exact --sha256 before installing");
          const out=readArg(rest,"out");if(!out)throw new Error("Pass --out=<new local pack.json>");
          fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(pack,null,2),{flag:"wx"});console.log(`[glint] persona pack saved: ${out}`);return;
        }
      }
      if(id)throw new Error("Unknown catalog id");return;
    }
    case "ask":
      return runScript("ask", rest);
    case "rehearse":
      return runScript("rehearse", rest);
    case "reexplain":
      return runScript("reexplain", rest);
    case "studio":
      return runtime.runStudio();
    default:
      console.log(
        [
          "glint — 把文档/想法/代码库变成讲解视频",
          "",
          "  pnpm glint make --source=doc.md            一次出片(合成+配音+配乐)",
          "  pnpm glint make --idea=\"一句话\" --engine=llm --polish   LLM 编剧+试讲+自动重讲",
          "  pnpm glint make --code=../repo             代码走读视频",
          "  pnpm glint check --project=project.json --source=source.md",
          "  pnpm glint render|ask|rehearse|reexplain|studio|templates",
        ].join("\n"),
      );
      if (command !== "help") process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
