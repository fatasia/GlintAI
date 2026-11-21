import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCliRuntime, normalizeCommandArgs, readArg, renderArgs, sourceInput } from "./glint-runtime";
import { styleRhythmIssues } from "./style-rhythm";
import { composeFromMarkdown, composeFromSource, isTemplateId, reviewProject, craftLint, lintVerdict } from "@glintai/composer";
import { planToSource, VideoPlan } from "@glintai/composer/plan";
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
function enforceWebMakePolicy(project: unknown): void {
  if (process.env.GLINT_WEB_MAKE_POLICY !== "1") return;
  const parsed = parseProject(project);
  if (parsed.scenes.some(scene => scene.kind === "html" || scene.kind === "three")) {
    throw new Error("Web 不支持渲染 HTML 或 3D 场景；请导出工程后使用本机 glint render。");
  }
}
export async function runMake(args: string[]): Promise<void> {
  const input = sourceInput(args);
  const beatGrid = await (await import("./beat-policy")).beatsForMake(args);
  // Multiple data sources share one editable SceneScript; workbook sheets are separate scenes.
  const sources = args.filter(a => a.startsWith("--source=")).map(a => a.slice(9));
  if (input.path && (/\.(csv|tsv|xlsx)$/i.test(input.path) || fs.statSync(input.path).isDirectory())) {
    const { tableProject } = await import("./table-sources");
    const table = await tableProject(sources, { title: readArg(args, "title"), kind: readArg(args, "kind"), id: readArg(args, "id"), language: readArg(args, "language"), aspect: readArg(args, "aspect") as SceneScriptProject["aspect"], sheet: readArg(args, "sheet"), python: readArg(args, "table-python") });
    const project = table.project;
    enforceWebMakePolicy(project);
    const outDir = path.resolve(STUDIO_DIR, "out"); fs.mkdirSync(outDir, { recursive: true });
    const projectPath = path.join(outDir, `${project.id}.project.json`); fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    for (const warning of table.warnings) console.warn(`[glint] table: ${warning}`);
    console.log(`[glint] ${table.tables} tables → ${project.scenes.length} chart scenes`);
    const format = readArg(args, "format") ?? "mp4";
    const output = readArg(args, "out") ? path.resolve(readArg(args, "out")!) : path.join(outDir, `${project.id}.${format === "project.json" ? "project.json" : "mp4"}`);
    if (format === "project.json") { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(project, null, 2)); console.log(`[glint] project written → ${output}`); return; }
    const { renderWithQualityGate } = await import("./make-quality");
    const accepted = await renderWithQualityGate({ projectPath, output, beatGrid, tts: readArg(args, "tts") ?? "auto", music: readArg(args, "music") ?? "synth", fast: hasFlag(args, "fast"), plate: hasFlag(args, "plate"), noCache: hasFlag(args, "no-cache"), resolution: readArg(args, "resolution") as never });
    console.log(`[glint] make done — "${project.title}" → ${accepted.output}`);
    return;
  }
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
  console.log(
    `[glint]    project "${project.title}" — ${project.scenes.length} scenes → ${sourcePath}`,
  );
  if ((hasFlag(args, "rehearse") || hasFlag(args, "polish")) && !llm)
    throw new Error("Rehearsal requires a configured LLM.");
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
  const backend = readArg(args, "backend") ?? "native";
  if (!["native", "reference"].includes(backend)) throw new Error("backend must be native or reference");
  if (beatGrid && backend === "reference") (await import("./beat-policy")).injectBeatGrid(project, beatGrid);
  const { repairPresentation } = await import("./presentation-repair");
  const repair = repairPresentation(project);
  project = repair.project;
  enforceWebMakePolicy(project);
  fs.writeFileSync(path.join(outDir, `${project.id}.repair.json`), JSON.stringify({ changes: repair.changes, remaining: repair.issues, verdict: repair.verdict }, null, 2));
  if (repair.verdict === "red") throw new Error("Presentation checks still fail after one bounded repair; inspect repair.json. Content was not rewritten.");
  const projectPath = path.join(outDir, `${project.id}.project.json`);
  fs.writeFileSync(path.join(outDir, `${project.id}.quality.json`), JSON.stringify(reviewProject(project, composed.sourceText), null, 2));
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
  const format = readArg(args, "format") ?? "mp4";
  console.log(`[glint] 4/4 rendering (${backend}, ${format})...`);
  let outputPath: string;
  if (backend === "reference" || format !== "mp4") {
    await runScript("render", renderArgs(projectPath, args));
    outputPath = readArg(args, "out") ? path.resolve(readArg(args, "out")!) : path.resolve(STUDIO_DIR, "out", `${project.id}.${format}`);
  } else {
    const { renderWithQualityGate } = await import("./make-quality");
    outputPath = readArg(args, "out") ? path.resolve(readArg(args, "out")!) : path.join(outDir, `${project.id}-${Date.now()}.mp4`);
    const accepted = await renderWithQualityGate({ projectPath, output: outputPath, beatGrid, tts: readArg(args, "tts") ?? "auto", music: readArg(args, "music") ?? "synth", fast: hasFlag(args, "fast"), plate: hasFlag(args, "plate"), noCache: hasFlag(args, "no-cache"), resolution: readArg(args, "resolution") as never });
    outputPath = accepted.output;
  }
  if (format === "mp4" && backend === "reference") {
    const { runQa, printQaReport } = await import("./qa");
    const qa = await runQa(outputPath);
    fs.writeFileSync(`${outputPath}.qa.json`, JSON.stringify(qa, null, 2));
    printQaReport(qa);
    if (qa.verdict === "red") throw new Error(`make produced a red QA result; inspect ${outputPath}.qa.json`);
  }
  console.log(`[glint] make done — "${project.title}"`);
}
async function main(): Promise<void> {
  const [command, ...raw] = process.argv.slice(2);
  const normalized = normalizeCommandArgs(command, raw);
  const rest = resolvePaths(normalized);
  switch (command) {
    case "make":
      return runMake(rest);
    case "quick": {
      // Skill/agent fast path: one passage in, one final video path out.
      const source = readArg(rest, "source"), text = readArg(rest, "text");
      if (!source && !text) throw new Error("quick requires --source=<file> or --text=<passage>");
      const out = path.resolve(readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", `quick-${Date.now()}.mp4`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      let input = source;
      if (!input) {
        input = `${out}.source.md`;
        fs.writeFileSync(input, text!);
      }
      const args = [`--source=${input}`, `--tts=${readArg(rest, "tts") ?? "mock"}`, `--music=${readArg(rest, "music") ?? "off"}`,
        `--aspect=${readArg(rest, "aspect") ?? "16:9"}`, `--out=${out}`, ...(hasFlag(rest, "quality") ? [] : ["--fast"])];
      await runMake(args);
      console.log(`\n✓ 视频：${out}\n  继续修改时可在工作台打开本次工程（apps/studio/out/*.project.json），或用 --quality 重出母版。`);
      return;
    }
    case "plan": {
      // v10: a change budget (`--set`/`--budget`) shares the name with the older multi-step task plan.
      if (rest.some(arg => arg.startsWith("--set=")) || hasFlag(rest, "budget")) {
        const { runPlan } = await import("./build");
        runPlan(rest);
        return;
      }
      const projectPath = readArg(rest, "project"), out = readArg(rest, "out");
      if (!projectPath) throw new Error("plan requires --project=<scenescript.json>");
      const { buildProjectPlan } = await import("./project-plan");
      const plan = buildProjectPlan(projectPath, { tts: readArg(rest, "tts"), music: readArg(rest, "music"), fast: hasFlag(rest, "fast"), resolution: readArg(rest, "resolution"), deck: hasFlag(rest, "deck"), review: hasFlag(rest, "review"), feedback: readArg(rest, "feedback") });
      const planPath = out ?? path.join(path.dirname(path.resolve(projectPath)), "plan.json");
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { flag: "wx" });
      console.log(`[glint] plan: ${plan.steps.length} steps → ${planPath}; 执行: glint task --plan=${path.basename(planPath)} --out=<任务目录>`);
      return;
    }
    case "build": {
      const { runBuild } = await import("./build");
      await runBuild(rest);
      return;
    }
    case "verify": {
      if (hasFlag(rest, "receipt") || readArg(rest, "receipt")) {
        const { runVerify } = await import("./build");
        await runVerify(rest);
        return;
      }
      throw new Error("verify requires --receipt=<file.receipt.json>");
    }
    case "apply": {
      const projectPath = readArg(rest, "project");
      const changes = rest.filter(arg => arg.startsWith("--set=")).map(arg => arg.slice(6));
      if (!projectPath || !changes.length) throw new Error("apply requires --project=<scenescript.json> and at least one --set=path=value");
      const { applyProjectChanges } = await import("./build");
      const result = applyProjectChanges({ projectPath, changes, expectedRevision: readArg(rest, "revision") });
      console.log(`[glint] applied ${changes.length} change(s) → ${result.revision}`);
      return;
    }
    case "clip": {
      const { runClipCommand } = await import("./longform-clip");
      await runClipCommand(rest);
      return;
    }
    case "brand": {
      // W5 TEAM-01: merge a brand pack over an installed theme, print CSS vars.
      const { parseBrandPack, brandTheme } = await import("@glintai/design-tokens/brand");
      const { tokensToCssVariables } = await import("@glintai/design-tokens");
      const packInput = readArg(rest, "pack"), outFile = readArg(rest, "out");
      const base = (readArg(rest, "base") ?? "glint-dark") as Parameters<typeof brandTheme>[0];
      const { pack, issues } = parseBrandPack(packInput ? JSON.parse(fs.readFileSync(packInput, "utf8")) : { name: readArg(rest, "name") ?? "品牌", colors: { accent: readArg(rest, "accent") ?? "#9b8bfb", ...(readArg(rest, "bg") ? { bg: readArg(rest, "bg") } : {}), ...(readArg(rest, "text") ? { text: readArg(rest, "text") } : {}) }, ...(readArg(rest, "logo") ? { logoText: readArg(rest, "logo") } : {}) });
      if (!pack) throw new Error(`品牌包无效：${issues.join("；")}`);
      const { theme, issues: contrast } = brandTheme(base, pack);
      for (const issue of contrast) console.warn(`[glint] 对比度：${issue}`);
      const css = tokensToCssVariables(theme);
      const projectFile = readArg(rest, "project");
      if (projectFile) {
        // SceneScript theme accepts inline token overrides (resolveTheme), so
        // the merged brand tokens go straight into the project and render.
        const project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
        project.theme = { ...theme, name: pack.name, base };
        fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
        console.log(`[glint] brand：${pack.name} 已写入工程 ${path.basename(projectFile)}（渲染走 resolveTheme 内联覆盖）`);
        return;
      }
      if (outFile) { fs.writeFileSync(outFile, css); console.log(`[glint] brand：${pack.name}（基于 ${base}）→ ${outFile}`); }
      else console.log(css);
      return;
    }
    case "clip-copy": {
      // S06 copy step: per-clip platform copy from the configured text model.
      const manifestFile = readArg(rest, "manifest");
      if (!manifestFile) throw new Error("clip-copy requires --manifest=<clips.json>");
      const { writeClipCopy } = await import("./clip-copy");
      const { copies, manifestFile: written } = await writeClipCopy({ manifestFile });
      console.log(`[glint] clip-copy：${copies.length} 条文案 → ${written}`);
      for (const copy of copies) console.log(`  ${copy.id}: ${copy.title}｜${copy.hook}`);
      return;
    }
    case "batch": {
      // S07 steps 1-5: validate, fill, budget, schedule and resume a product batch.
      const tableFile = readArg(rest, "table"), templateFile = readArg(rest, "template"), out = readArg(rest, "out");
      const model = readArg(rest, "model");
      if (!tableFile || !templateFile) throw new Error("batch requires --table=<csv> and --template=<plan.json>");
      const { validateBatchTable, applyTemplate, expandSceneGroups, estimateBatchBudget, scheduleBatch, resumeBatch } = await import("@glintai/composer/batch");
      const table = validateBatchTable(fs.readFileSync(tableFile, "utf8"), { assetExists: asset => fs.existsSync(asset) || fs.existsSync(path.resolve(path.dirname(path.resolve(tableFile)), asset)) });
      for (const issue of table.issues) console.warn(`[glint] 表第 ${issue.row} 行 ${issue.column}：${issue.message}`);
      if (!table.rows.length) throw new Error("没有可用的商品行；先修复上表中的错误。");
      const template = JSON.parse(fs.readFileSync(templateFile, "utf8"));
      const outDir = path.resolve(out ?? path.join(STUDIO_DIR, "out", "batch"));
      fs.mkdirSync(outDir, { recursive: true });
      if (model) {
        const { MediaGatewayClient } = await import("@glintai/media");
        const client = new MediaGatewayClient({ baseUrl: process.env.GLINT_MEDIA_BASE_URL ?? "", apiKey: process.env.GLINT_MEDIA_API_KEY ?? "" });
        const raw = await client.pricing(model);
        const billing = String(raw?.channel_groups?.[0]?.billing_method ?? "");
        const price = Number(raw?.channel_groups?.[0]?.base_price ?? 0) || Number(raw?.channel_groups?.[0]?.input_token_price ?? 0);
        const pricing = billing.includes("秒") ? { perSecond: price } : { perCall: price };
        const planSeconds = template.scenes?.reduce((sum: number, scene: { seconds: number }) => sum + scene.seconds, 0) ?? 0;
        const budget = estimateBatchBudget(table.rows, { planSeconds, pricing: { ...pricing, currency: "算力" } });
        console.log(`[glint] 预算：${budget.rows} 行 × ${budget.perRow} = ${budget.total} ${budget.currency}（${billing || "按次"}；${budget.basis}）`);
      }
      const force = hasFlag(rest, "force");
      const planFileFor = (id: string) => path.join(outDir, `${id}.plan.json`);
      const runStage = hasFlag(rest, "run");
      // Plan stage: a valid plan counts as done. Run stage: only a rendered mp4 does.
      const { todo, done } = resumeBatch(table.rows, { isDone: row => {
        if (force) return false;
        if (!fs.existsSync(planFileFor(row.id))) return false;
        if (runStage) return fs.existsSync(path.join(outDir, row.id, `${row.id}.mp4`));
        try { return Boolean(JSON.parse(fs.readFileSync(planFileFor(row.id), "utf8")).title); } catch { return false; }
      } });
      if (done.length) console.log(`[glint] 已完成 ${done.length} 行，跳过（--force 重做全部）`);
      const maxConcurrent = Number(readArg(rest, "concurrency") ?? 2);
      const { chunks, duplicates } = scheduleBatch(todo, { maxConcurrent, keyOf: row => row.id });
      const manifest = chunks.flat().map(row => {
        const filled = applyTemplate(expandSceneGroups(template, row), row);
        const planFile = planFileFor(row.id);
        fs.writeFileSync(planFile, JSON.stringify(filled.plan, null, 2));
        return { id: row.id, name: row.name, planFile, warnings: filled.warnings };
      });
      // BATCH×GEN bridge: generate missing product assets through the media gateway.
      const fillModel = readArg(rest, "fill-assets");
      const resolvedAssets = new Map<string, string[]>();
      const assetDir = path.join(outDir, "assets");
      if (fillModel) {
        const { MediaGatewayClient, downloadMediaResult } = await import("@glintai/media");
        const client = new MediaGatewayClient({ baseUrl: process.env.GLINT_MEDIA_BASE_URL ?? "", apiKey: process.env.GLINT_MEDIA_API_KEY ?? "" });
        fs.mkdirSync(assetDir, { recursive: true });
        const writeAtomic = (file: string, bytes: Uint8Array) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };
        for (const row of table.rows) {
          const missing = row.assets.filter(asset => !fs.existsSync(asset) && !fs.existsSync(path.join(outDir, asset)));
          const generated: string[] = [...row.assets];
          for (const [index, asset] of missing.entries()) {
            const prompt = `${row.assetPrompt || `${row.name}，${row.sellingPoints[0] ?? "产品图"}`}，商业摄影质感，浅景深，16:9 构图`;
            const taskId = await client.submit(fillModel, prompt, {}, AbortSignal.timeout(30_000));
            const task = await client.wait(taskId, { timeoutMs: 300_000 });
            if (task.state !== "success" || !task.result_url) throw new Error(`素材生成失败（${row.id} #${index + 1}）：${task.state}`);
            // TUN/Fake-IP environments resolve public hosts into reserved ranges;
            // retry with the opt-in public-DNS path, same as the media jobs.
            let result;
            try { result = await downloadMediaResult(task, AbortSignal.timeout(120_000)); }
            catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (!/Private, loopback or reserved/.test(reason) || process.env.GLINT_MEDIA_PUBLIC_DNS !== "1") throw error;
              result = await downloadMediaResult(task, AbortSignal.timeout(120_000), { publicDns: true });
            }
            const local = `${row.id}-${index + 1}${result.contentType.includes("png") ? ".png" : ".jpg"}`;
            writeAtomic(path.join(assetDir, local), result.bytes);
            generated[index] = `assets/${local}`;
            console.log(`[glint] fill-assets：${row.id} #${index + 1} → ${local}（${result.bytes.length} 字节）`);
          }
          resolvedAssets.set(row.id, generated);
        }
      }
      const manifestFile = path.join(outDir, "batch.json");
      fs.writeFileSync(manifestFile, JSON.stringify({ rows: manifest, issues: table.issues, schedule: { maxConcurrent, chunkSizes: chunks.map(chunk => chunk.length) }, duplicates: duplicates.map(entry => entry.key), ...(resolvedAssets.size ? { assetsResolved: [...resolvedAssets.entries()].map(([id, files]) => ({ id, files })) } : {}) }, null, 2));
      console.log(`[glint] batch：本轮填充 ${manifest.length} 个方案 → ${outDir}（并发块 ${chunks.map(chunk => chunk.length).join("/")}；清单 ${path.basename(manifestFile)}）`);
      if (!hasFlag(rest, "run")) { console.log("逐个制作：glint task --plan=<file> --out=<目录>；或重跑加 --run 批量渲染。"); return; }

      // BATCH executor: offline-compose each plan into a SceneScript project,
      // then render rows concurrently in separate processes (build is heavy).
      const { runChunked, applyBatchAssets } = await import("@glintai/composer/batch");
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const require = createRequire(import.meta.url);
      const rowsById = new Map(manifest.map(entry => [entry.id, entry]));
      const runs = await runChunked(chunks.map(chunk => chunk.map(row => rowsById.get(row.id)!)), async entry => {
        const rowDir = path.join(outDir, entry.id);
        fs.mkdirSync(rowDir, { recursive: true });
        const projectPath = path.join(rowDir, `${entry.id}.project.json`);
        const plan = VideoPlan.parse(JSON.parse(fs.readFileSync(entry.planFile, "utf8")));
        const project = composeFromMarkdown(planToSource(plan), { projectId: `batch-${entry.id}`, aspect: plan.platform, theme: plan.theme });
        // Bind generated assets: {{素材N}} scenes become real image scenes.
        const rowAssetDir = path.join(rowDir, "assets"); fs.mkdirSync(rowAssetDir, { recursive: true });
        const { project: staged, bound } = applyBatchAssets(project, resolvedAssets.get(entry.id) ?? [], { copyAsset: file => {
          const target = path.join(rowAssetDir, path.basename(file));
          const source = path.join(assetDir, path.basename(file));
          if (fs.existsSync(source)) fs.copyFileSync(source, target);
          return `assets/${path.basename(file)}`;
        } });
        if (bound) console.log(`[${entry.id}] 素材绑定：${bound} 个场景转图片镜头`);
        fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
        const output = path.join(rowDir, `${entry.id}.mp4`);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, path.join(scriptDir, "glint.ts"), "build", "--project=" + projectPath, "--out=" + output, "--tts=" + (readArg(rest, "tts") ?? "mock"), "--fast"], { cwd: STUDIO_DIR, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", (chunk: Buffer) => process.stdout.write(`[${entry.id}] ${chunk}`));
          child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[${entry.id}] ${chunk}`));
          child.once("error", reject);
          child.once("close", (code: number | null) => code === 0 ? resolve() : reject(new Error(`build exited with code ${code}`)));
        });
        return { id: entry.id, projectPath, output };
      });
      const outcomes = runs.map(run => ({ id: run.item.id, ok: run.ok, ...(run.value ? run.value : {}), ...(run.error ? { error: run.error } : {}) }));
      fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), run: outcomes }, null, 2));
      const failed = outcomes.filter(outcome => !outcome.ok);
      console.log(`[glint] batch run：${outcomes.length - failed.length}/${outcomes.length} 成功${failed.length ? `；失败行 ${failed.map(outcome => `${outcome.id}(${outcome.error})`).join("、")}，重跑自动恢复` : ""}`);
      if (failed.length) process.exitCode = 1;
      return;
    }
    case "blind": {
      // QA-02: identity-free comparison and score distribution over projects.
      const { blindMetrics, blindCompare, scoreDistribution } = await import("@glintai/composer/blind");
      const load = (file: string) => parseProject(JSON.parse(fs.readFileSync(file, "utf8")));
      const dir = readArg(rest, "dir");
      if (dir) {
        const files: string[] = [];
        const walk = (entry: string) => { for (const name of fs.readdirSync(entry, { withFileTypes: true })) { const full = path.join(entry, name.name); if (name.isDirectory()) walk(full); else if (name.name.endsWith(".project.json")) files.push(full); } };
        walk(dir);
        if (files.length < 2) throw new Error("分布至少需要目录里两个 .project.json");
        const distribution = scoreDistribution(files.map(load));
        console.log(`[glint] 盲评分布（${distribution.count} 个工程，指标方向：语速为展示项不判胜负）`);
        for (const metric of distribution.metrics) console.log(`  ${metric.metric}: min ${metric.min} / 中位 ${metric.median} / max ${metric.max}`);
        return;
      }
      const a = readArg(rest, "a"), b = readArg(rest, "b");
      if (!a || !b) throw new Error("blind requires --a=<project.json> --b=<project.json>（或 --dir=<目录> 看分布）");
      const comparison = blindCompare(blindMetrics(load(a)), blindMetrics(load(b)));
      console.log("[glint] 盲评对比（A/B 脱标识；揭晓映射前先记录你的偏好）");
      for (const row of comparison.rows) console.log(`  ${row.metric}: A ${row.A} | B ${row.B} → ${row.winner === "tie" ? "平" : `${row.winner} 优`}`);
      console.log(`  ${comparison.summary}`);
      return;
    }
    case "reference": {
      const { runReferenceVideo } = await import("./reference-video");
      await runReferenceVideo(rest);
      return;
    }
    case "reference-project": {
      const { runReferenceProject } = await import("./reference-video");
      await runReferenceProject(rest);
      return;
    }
    case "analyze-reference": {
      // R-10 参考片复刻：数字测量（本地 ffmpeg，无 LLM）。
      const { runAnalyzeReference } = await import("@glintai/composer/recreate");
      await runAnalyzeReference(rest);
      return;
    }
    case "recreate-plan": {
      const { runRecreatePlan } = await import("@glintai/composer/recreate");
      await runRecreatePlan(rest);
      return;
    }
    case "packs": {
      const { runCreationPacks } = await import("./creation-packs-cli");
      return void runCreationPacks(rest);
    }
    case "catalog-import":
    case "catalog-check": {
      const { runCatalogCli } = await import("./template-catalog-cli");
      return void runCatalogCli(rest, command === "catalog-import" ? "import" : "check");
    }
    case "look": return (await import("./look")).runLook(rest).then(() => undefined);
    case "project-migrate": return (await import("./project-container-io")).runProjectMigration(rest).then(() => undefined);
    case "delivery-check": {
      const { runDeliveryCheck } = await import("./delivery-check");
      await runDeliveryCheck(rest);
      return;
    }
    case "verify-export": {
      const { runVerifyExport } = await import("./verify-export");
      await runVerifyExport(rest);
      return;
    }
    case "timeline": {
      const { runTimeline } = await import("./timeline-cli");
      runTimeline(rest);
      return;
    }
    case "edit": {
      const { runEdit } = await import("./edits");
      runEdit(rest);
      return;
    }
    case "assets": {
      const { runAssets } = await import("./asset-identities");
      runAssets(rest);
      return;
    }    case "changes": {
      const { runChanges } = await import("./edits");
      runChanges(rest);
      return;
    }    case "diff": {
      const { runFrameDiff } = await import("./frame-diff");
      await runFrameDiff(rest);
      return;
    }
    case "prove": {
      const { runProve } = await import("./prove");
      runProve(rest);
      return;
    }
    case "mcp": {
      const { runMcpServer } = await import("./mcp");
      await runMcpServer();
      return;
    }    case "review": {
      const projectPath = readArg(rest, "project"), out = readArg(rest, "out");
      if (!projectPath || !out) throw new Error("review requires --project= --out=<new sibling project.json>");
      const { reviewProjectLoop } = await import("./review-loop");
      const result = await reviewProjectLoop({ projectPath, out, llm: requireLlm(), feedback: readArg(rest, "feedback"), maxScenes: Number(readArg(rest, "max-scenes") ?? 2), verify: !hasFlag(rest, "no-verify") });
      console.log(JSON.stringify(result, null, 2)); return;
    }
    case "insights": {
      const source = readArg(rest, "source"), out = readArg(rest, "out");
      if (!source || !out) throw new Error("insights requires --source=<learning records directory> --out=report.html");
      const { exportInsights } = await import("./understanding");
      const projectPath = readArg(rest, "project");
      const result = exportInsights(source, out, projectPath ? parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8"))).id : undefined);
      console.log(`[glint] insights: ${result.sessions} sessions / ${result.groups.length} groups → ${result.output}`); return;
    }
    case "report": {
      const projectPath = readArg(rest, "project"), out = readArg(rest, "out");
      if (!projectPath || !out) throw new Error("report requires --project= and --out=<report.html>");
      const { generateReport } = await import("./project-report");
      const result = await generateReport({ projectPath, out, video: readArg(rest, "video"), taskDir: readArg(rest, "task-dir") });
      console.log(`[glint] report: ${result.scenes} scenes, QA ${result.qa} → ${result.out}`);
      return;
    }
    case "alpha-frames": {
      const projectPath = readArg(rest, "project"), outDir = readArg(rest, "out");
      if (!projectPath || !outDir) throw new Error("alpha-frames requires --project=<project.json> --out=<new directory>");
      const width = readArg(rest, "width"), height = readArg(rest, "height");
      if ((width === undefined) !== (height === undefined)) throw new Error("Pass --width and --height together");
      const { exportAlphaFrames } = await import("./alpha-frames");
      const result = await exportAlphaFrames({ projectPath, outDir, ...(width === undefined ? {} : { width: Number(width), height: Number(height) }) });
      console.log(JSON.stringify(result, null, 2)); return;
    }
    case "alpha-webm": {
      const projectPath = readArg(rest, "project"), out = readArg(rest, "out");
      if (!projectPath || !out) throw new Error("alpha-webm requires --project=<project.json> --out=<new.webm>");
      const width = readArg(rest, "width"), height = readArg(rest, "height");
      if ((width === undefined) !== (height === undefined)) throw new Error("Pass --width and --height together");
      const { exportAlphaWebm } = await import("./alpha-webm");
      const result = await exportAlphaWebm({ projectPath, out, ...(width === undefined ? {} : { width: Number(width), height: Number(height) }) });
      console.log(JSON.stringify(result, null, 2)); return;
    }
    case "image-canvas": {
      const src = readArg(rest, "src"), out = readArg(rest, "out");
      if (!src || !out) throw new Error("image-canvas requires --src=<image> --out=<new.png> and margins in pixels");
      const margin = (name: string) => { const value = readArg(rest, name); return value === undefined ? undefined : Number(value); };
      const { expandImageCanvas } = await import("./image-canvas");
      const result = await expandImageCanvas({ src, out, left: margin("left"), right: margin("right"), top: margin("top"), bottom: margin("bottom"), color: readArg(rest, "color") });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "image-edit": {
      const src = readArg(rest, "src"), out = readArg(rest, "out");
      const preset = readArg(rest, "preset");
      const prompt = readArg(rest, "prompt") ?? (preset ? (await import("./image-edit")).EDIT_PRESETS[preset] : undefined);
      if (!src || !out || !prompt) throw new Error("image-edit requires --src=<image> --out=<new image path> and (--prompt=\"改动\" 或 --preset=remove-bg|new-background|retouch|restore|upscale)");
      if (!readArg(rest, "prompt") && (preset === "remove-bg" || preset === "upscale")) console.warn(preset === "remove-bg" ? "remove-bg 是白底改图提示词，不生成透明抠图。" : "upscale 是清晰精修提示词，不保证输出像素尺寸放大。");
      const { imageEdit } = await import("./image-edit");
      const result = await imageEdit({ src, prompt, out, mask: readArg(rest, "mask"), taskId: readArg(rest, "task"), model: readArg(rest, "model"), baseUrl: process.env.GLINT_MEDIA_BASE_URL, apiKey: process.env.GLINT_MEDIA_API_KEY, size: readArg(rest, "size"), aspectRatio: readArg(rest, "aspect"), publicDns: process.env.GLINT_MEDIA_PUBLIC_DNS === "1" });
      console.log(`[glint] image edited (${result.cost ?? "?"} 算力) → ${result.output}; 版本链: ${result.chain}`);
      return;
    }
    case "edit-studio":
      return (async () => { const { runEditStudio } = await import("./edit-studio"); await runEditStudio(rest); })();
    case "tools": {
      const { CAPABILITIES } = await import("./capability-catalog");
      console.log(JSON.stringify(CAPABILITIES, null, 2)); return;
    }
    case "inspire": {
      const { listInspiration, instantiateInspiration } = await import("./capability-catalog");
      const use = readArg(rest, "use"), output = readArg(rest, "out");
      if (use) { if (!output) throw new Error("inspire --use requires --out=<new directory>"); console.log(JSON.stringify(instantiateInspiration(use, output), null, 2)); }
      else console.log(JSON.stringify(listInspiration(readArg(rest, "query")), null, 2));
      return;
    }
    case "task": {
      const plan = readArg(rest, "plan"), directory = readArg(rest, "out");
      if (!plan || !directory) throw new Error("task requires --plan=<plan.json> and --out=<task directory>");
      const { runAgentTask } = await import("./agent-task-cli");
      const result = await runAgentTask(plan, directory);
      console.log(`[glint] task: ${Object.values(result.steps).filter(step => step.state === "completed").length} steps completed`);
      return;
    }
    case "native-worker":
      return runScript("native-worker", rest);
    case "render-native": {
      const projectPath = readArg(rest, "project"), output = readArg(rest, "out");
      if (!projectPath || !output) throw new Error("render-native requires --project= and --out=");
      const { renderNative } = await import("./native-render");
      await renderNative({ projectPath, output, fast: hasFlag(rest, "fast"), plate: hasFlag(rest, "plate"), scenes: readArg(rest, "scenes")?.split(","), tts: readArg(rest, "tts"), music: readArg(rest, "music"), noCache: hasFlag(rest, "no-cache"), resolution: readArg(rest, "resolution") as never });
      return;
    }
    case "deck": {
      const projectPath = readArg(rest, "project"), outDir = readArg(rest, "out");
      if (!projectPath || !outDir) throw new Error("deck requires --project= and --out=<new directory>");
      const { exportDeck } = await import("./deck");
      const project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
      const result = await exportDeck({ project, projectDir: path.dirname(projectPath), outDir, variant: readArg(rest, "variant") });
      console.log(`[glint] deck: ${result.sceneCount} scenes → ${result.indexPath}`);
      return;
    }
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
      const { STYLE_PACKS } = await import("@glintai/design-tokens");
      console.log(`\n风格包(主题): ${STYLE_PACKS.map((pack) => pack.name).join(" | ")}\n→ pnpm glint styles 看说明`);
      return;
    }
    case "style-catalog": {
      const { runStyleCatalog } = await import("./style-catalog");
      runStyleCatalog(rest, path.resolve(STUDIO_DIR, "../../outputs/style-samples"));
      return;
    }
    case "styles": {
      const { AESTHETIC_FONTS, STYLE_PACKS } = await import("@glintai/design-tokens");
      if (readArg(rest, "json") !== undefined || rest.includes("--json")) {
        console.log(JSON.stringify({ fonts: AESTHETIC_FONTS, packs: STYLE_PACKS }, null, 2));
        return;
      }
      for (const pack of STYLE_PACKS) {
        console.log(`${pack.name.padEnd(16)} ${pack.label.padEnd(8)} [${pack.category}] ${pack.summary}`);
        for (const rule of pack.rules) console.log(`${" ".repeat(28)}· ${rule}`);
        const { typography, composition, motion, pacing, sound } = pack.aesthetic;
        const font = (key: keyof typeof AESTHETIC_FONTS) => `${key}(${AESTHETIC_FONTS[key].name} ${AESTHETIC_FONTS[key].version} ${AESTHETIC_FONTS[key].license})`;
        console.log(`${" ".repeat(28)}字：${font(typography.display)} / ${font(typography.body)} / ${font(typography.mono)}`);
        console.log(`${" ".repeat(28)}构：${composition.grid}；${composition.density}；安全区 ${composition.safeArea}`);
        console.log(`${" ".repeat(28)}动：${motion.easing} · 入场 ${motion.entranceMs}ms · 减弱动效 ${motion.reducedMotion}`);
        console.log(`${" ".repeat(28)}节：${pacing.shotMs[0]}–${pacing.shotMs[1]}ms/镜 · 停留 ${pacing.holdMs}ms · ${pacing.cutPattern}`);
        console.log(`${" ".repeat(28)}声：${sound.mood} · ${sound.targetLufs} LUFS · 闪避 ${sound.duckingDb}dB`);
      }
      console.log("\n字体只做引用，不打包字节；可嵌入版本均为 OFL-1.1。用 --json 取完整数据。");
      return;
    }
    case "lint": {
      const projectFile = readArg(rest, "project");
      if (!projectFile) throw new Error("lint requires --project=<scenescript.json>");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const issues = [...craftLint(project), ...styleRhythmIssues(project)];
      const verdict = lintVerdict(issues);
      const icon = { error: "✗", warn: "◆" } as const;
      for (const issue of issues) {
        console.log(`  ${icon[issue.level]} [${issue.rule}]${issue.sceneId ? ` ${issue.sceneId}:` : ""} ${issue.message}`);
      }
      console.log(`[glint] lint ${verdict.toUpperCase()} — ${issues.filter((issue) => issue.level === "error").length} error / ${issues.filter((issue) => issue.level === "warn").length} warn`);
      if (readArg(rest, "out")) fs.writeFileSync(readArg(rest, "out")!, JSON.stringify({ verdict, issues }, null, 2));
      if (hasFlag(rest, "strict") && verdict === "red") process.exitCode = 1;
      return;
    }
    case "qa": {
      const video = readArg(rest, "video");
      if (!video) throw new Error("qa requires --video=<rendered.mp4>");
      const { runQa, printQaReport } = await import("./qa");
      const report = await runQa(path.resolve(video));
      printQaReport(report);
      if (readArg(rest, "out")) fs.writeFileSync(readArg(rest, "out")!, JSON.stringify(report, null, 2));
      if (hasFlag(rest, "strict") && report.verdict === "red") process.exitCode = 1;
      return;
    }
    case "jianying": {
      const projectFile = readArg(rest, "project"), video = readArg(rest, "video");
      if (!projectFile || !video) throw new Error("jianying requires --project=<scenescript.json> and --video=<rendered.mp4>");
      const { probeVideo } = await import("./qa");
      const { exportJianyingDraft } = await import("./jianying");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const spec = await probeVideo(path.resolve(video));
      const outDir = readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", "jianying");
      const music = readArg(rest, "music");
      const result = exportJianyingDraft({ project, videoPath: path.resolve(video), videoSpec: spec, musicPath: music ? path.resolve(music) : undefined, outDir: path.resolve(outDir) });
      console.log(`[glint] jianying draft (experimental, 未真机验证): ${result.draftDir}`);
      console.log(`  ${result.sceneSegmentCount} 镜头段 / ${result.captionCueCount} 条字幕 / SRT: ${result.srtPath}`);
      console.log("  剪映打开后如提示升级草稿属正常;重导出请重跑本命令,不要读回剪映改过的草稿。");
      return;
    }
    case "lottie-studio": {
      const { runLottieStudio } = await import("./lottie-studio");
      await runLottieStudio(rest);
      return;
    }
    case "lottie-import": {
      const { runLottieImport } = await import("./lottie-import");
      runLottieImport(rest);
      return;
    }
    case "html-template": {
      const { runHtmlTemplate } = await import("./html-template");
      runHtmlTemplate(rest);
      return;
    }
    case "render-env": {
      const { runRenderEnv } = await import("./render-env");
      runRenderEnv(rest);
      return;
    }
    case "gltf-controls": {
      const { runGltfControls } = await import("./gltf-controls");
      runGltfControls(rest);
      return;
    }
    case "nle-render":
      return runScript("nle-render", rest);
    case "nle": {
      const projectFile = readArg(rest, "project"), video = readArg(rest, "video");
      if (!projectFile || !video) throw new Error("nle requires --project=<scenescript.json> and --video=<rendered.mp4>");
      const format = readArg(rest, "format") ?? "fcpxml";
      if (!["fcpxml", "edl"].includes(format)) throw new Error("nle --format must be fcpxml or edl");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const { probeVideo } = await import("./qa");
      const spec = await probeVideo(path.resolve(video));
      const { exportNleTimeline } = await import("./nle-export");
      const out = path.resolve(readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", `${project.id}.${format}`));
      const result = exportNleTimeline({ project, videoPath: path.resolve(video), format: format as "fcpxml" | "edl", outPath: out, spec });
      console.log(`[glint] ${format.toUpperCase()} (experimental, 未在 FCP/Premiere/Resolve 真机验证): ${result.file}`);
      console.log(`  ${result.cuts} 个镜头切点 / ${result.bytes} bytes`);
      if (result.warning) console.log(`  ${result.warning}`);
      return;
    }
    case "srt": {
      const projectFile = readArg(rest, "project");
      if (!projectFile) throw new Error("srt requires --project=<scenescript.json>");
      const { buildProjectCues, formatSrt, formatVtt } = await import("./jianying");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      let cues = buildProjectCues(project);
      const lang = readArg(rest, "lang");
      if (lang) {
        const { translateCues } = await import("./subtitle-translate");
        const { llmFromEnvironment } = await import("@glintai/llm");
        cues = await translateCues(cues, lang, llmFromEnvironment());
      }
      const format = readArg(rest, "format") ?? "srt";
      if (!["srt", "vtt", "both"].includes(format)) throw new Error("format must be srt, vtt or both");
      const out = readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", `${project.id}${lang ? `.${lang}` : ""}.srt`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, formatSrt(cues), "utf8");
      if (format !== "srt") {
        const vttOut = format === "both" ? out.replace(/\.srt$/, ".vtt") : (readArg(rest, "out") ? out.replace(/\.srt$/, ".vtt") : path.join(STUDIO_DIR, "out", `${project.id}${lang ? `.${lang}` : ""}.vtt`));
        fs.writeFileSync(vttOut, formatVtt(cues), "utf8");
        console.log(`[glint] ${cues.length} 条字幕 → ${out} + ${vttOut}`);
        return;
      }
      console.log(`[glint] ${cues.length} 条字幕 → ${out}`);
      return;
    }
    case "bundle": {
      const projectFile = readArg(rest, "project"), out = readArg(rest, "out");
      if (!projectFile || !out) throw new Error("bundle requires --project=<scenescript.json> --out=<bundle dir>");
      const { migrateProject } = await import("@glintai/scenescript/migrate");
      const { writeBundle } = await import("@glintai/scenescript/bundle");
      const { project } = migrateProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const plan = writeBundle(project, path.dirname(path.resolve(projectFile)), out);
      if (plan.missingAssets.length) console.log(`[glint] 警告：${plan.missingAssets.length} 个资源缺失，已记录在 manifest 但未拷贝：${plan.missingAssets.join("、")}`);
      console.log(`[glint] 资源包 → ${out}（${plan.manifest.assets.length} 个资源引用）`);
      return;
    }
    case "open-bundle": {
      const dir = readArg(rest, "dir");
      if (!dir) throw new Error("open-bundle requires --dir=<bundle dir>");
      const { openBundle } = await import("@glintai/scenescript/bundle");
      const opened = openBundle(dir);
      if (opened.missingAssets.length) console.log(`[glint] 警告：资源包缺 ${opened.missingAssets.length} 个文件：${opened.missingAssets.join("、")}`);
      if (opened.hashMismatches.length) throw new Error(`资源包校验失败，以下文件与 manifest 不符：${opened.hashMismatches.join("、")}`);
      console.log(`[glint] 工程 ${opened.project.id}「${opened.project.title}」：${opened.project.scenes.length} 场景，校验通过`);
      return;
    }
    case "bundle-chapters": {
      const files = rest.filter(arg => arg.startsWith("--project=")).map(arg => arg.slice("--project=".length));
      const out = readArg(rest, "out");
      if (!files.length || !out || files.some(file => !file)) throw new Error("bundle-chapters requires one or more --project=<chapter.json> and --out=<new directory>");
      const { writeChapterBundle } = await import("@glintai/scenescript/chapter-bundle");
      const inputs = files.map(file => ({ project: parseProject(JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))), root: path.dirname(path.resolve(file)) }));
      const result = writeChapterBundle(inputs, out);
      console.log(`[glint] 章节包 → ${out}（${result.chapters.length} 个工程）`);
      return;
    }
    case "inspect-chapters": {
      const dir = readArg(rest, "dir");
      if (!dir) throw new Error("inspect-chapters requires --dir=<chapter bundle>");
      const { inspectChapterBundle } = await import("@glintai/scenescript/chapter-bundle");
      console.log(JSON.stringify(inspectChapterBundle(dir), null, 2));
      return;
    }
    case "restore-chapters": {
      const dir = readArg(rest, "dir"), out = readArg(rest, "out");
      if (!dir || !out) throw new Error("restore-chapters requires --dir=<chapter bundle> --out=<new directory>");
      const { restoreChapterBundle } = await import("@glintai/scenescript/chapter-bundle");
      const result = restoreChapterBundle(dir, out);
      console.log(`[glint] 已验证并恢复 ${result.chapters.length} 个工程 → ${out}`);
      return;
    }
    case "drama-plan": {
      const script = readArg(rest, "script"), out = readArg(rest, "out");
      if (!script || !out) throw new Error("drama-plan requires --script=<剧本.txt> --out=<plan.json>");
      const { buildDramaEpisodePlan } = await import("@glintai/composer/drama-pipeline");
      const result = buildDramaEpisodePlan({ screenplay: fs.readFileSync(script, "utf8"), episode: Number(readArg(rest, "episode") ?? 1) || 1, episodeSize: Number(readArg(rest, "episode-size")) || undefined, theme: readArg(rest, "theme"), aspect: readArg(rest, "aspect") as "16:9" | "9:16" | "1:1" | undefined });
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ plan: result.plan, episodes: result.episodes, characters: result.characters }, null, 2));
      console.log(`[glint] 第${result.plan.title.match(/第(\d+)集/)?.[1] ?? 1}集：${result.plan.scenes.length} 镜头 / ${result.plan.totalSeconds}s / 角色 ${result.characters.join("、")} → ${out}`);
      return;
    }
    case "asset-impact": {
      const projectFile = readArg(rest, "project"), assetId = readArg(rest, "asset");
      if (!projectFile || !assetId) throw new Error("asset-impact requires --project=<scenescript.json> --asset=<assetId>");
      const { scenesAffectedByAsset } = await import("@glintai/scenescript/asset-invalidate");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const affected = scenesAffectedByAsset(project, assetId);
      console.log(JSON.stringify({ assetId, affectedSceneIds: affected, count: affected.length }, null, 2));
      return;
    }
    case "lang-variant": {
      const projectFile = readArg(rest, "project"), lang = readArg(rest, "lang"), translationsFile = readArg(rest, "translations"), out = readArg(rest, "out");
      if (!projectFile || !lang || !translationsFile || !out) throw new Error("lang-variant requires --project=<plan.json> --lang=<语言> --translations=<json> --out=<plan.json>");
      const { deriveLanguageVariant } = await import("@glintai/composer/multilang");
      const source = JSON.parse(fs.readFileSync(projectFile, "utf8")).plan ?? JSON.parse(fs.readFileSync(projectFile, "utf8"));
      const variant = deriveLanguageVariant(source, lang, JSON.parse(fs.readFileSync(translationsFile, "utf8")));
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(variant, null, 2));
      console.log(`[glint] ${lang} 版本（${variant.scenes.filter(scene => scene.narration).length} 条译文）→ ${out}`);
      return;
    }
    case "clip-transcribe": {
      const manifest = readArg(rest, "clips"), model = readArg(rest, "model");
      if (!manifest || !model) throw new Error("clip-transcribe requires --clips=<clips.json> --model=<多模态文本模型，如 gem-3.8-flash>");
      const { transcribeClips } = await import("./clip-insight");
      const result = await transcribeClips({ manifestFile: manifest, model });
      console.log(`[glint] 已转写 ${result.transcripts} 个片段，字幕与旁白写回 ${result.manifestFile}`);
      return;
    }
    case "clip-highlights": {
      const manifest = readArg(rest, "clips");
      if (!manifest) throw new Error("clip-highlights requires --clips=<clips.json> [--brief=主题] [--top=N]");
      const { pickHighlights } = await import("./clip-insight");
      const result = await pickHighlights({ manifestFile: manifest, brief: readArg(rest, "brief"), top: Number(readArg(rest, "top")) || undefined });
      console.log(`[glint] 亮点片段：${result.highlights.join("、")}（已写回 ${result.manifestFile}）`);
      return;
    }
    case "lipsync": {
      const face = readArg(rest, "face"), audio = readArg(rest, "audio"), out = readArg(rest, "out");
      if (!face || !audio || !out) throw new Error("lipsync requires --face=<人脸图> --audio=<配音音频> --out=<mp4> [--model=] [--duration-ms=] [--aspect=]");
      const { lipSync, heuristicMouthCheck } = await import("./lipsync");
      const result = await lipSync({ faceImage: face, audio, out, model: readArg(rest, "model"), durationMs: Number(readArg(rest, "duration-ms")) || undefined, aspect: readArg(rest, "aspect") as "9:16" | "16:9" | "1:1" | undefined, baseUrl: process.env.GLINT_MEDIA_BASE_URL, apiKey: process.env.GLINT_MEDIA_API_KEY });
      console.log(`[glint] 口型视频 → ${result.out}（${result.model}，${(result.durationMs / 1000).toFixed(1)}s，${result.cost ?? "?"} 算力，任务 ${result.taskId}）`);
      const check = await heuristicMouthCheck(result.out);
      console.log(`[glint] ${check.notes}`);
      return;
    }
    case "publish-kit": {
      const planFile = readArg(rest, "plan"), platform = readArg(rest, "platform"), out = readArg(rest, "out");
      if (!planFile || !platform || !out) throw new Error("publish-kit requires --plan=<plan.json> --platform=<douyin|shipinhao|bilibili> --out=<dir> [--tags=a,b]");
      const { writePublishKit } = await import("@glintai/composer/publish-presets");
      const raw = JSON.parse(fs.readFileSync(planFile, "utf8"));
      const plan = raw.plan ?? raw;
      const kit = writePublishKit(platform, { title: String(plan.title ?? ""), hook: String(plan.hook ?? ""), takeaway: String(plan.takeaway ?? "") }, out, (readArg(rest, "tags") ?? "").split(",").filter(Boolean));
      console.log(`[glint] ${platform} 发布包 → ${kit.file}（标题：${kit.title}）`);
      return;
    }
    case "beats": {
      const audio = readArg(rest, "audio");
      const bpm = readArg(rest, "bpm");
      if (!audio && !bpm) throw new Error("beats requires --audio= or --bpm= --duration=<seconds> [--offset=<ms>]");
      const { detectBeats } = await import("@glintai/music");
      const grid = bpm ? (await import("./beat-policy")).fixedBeatGrid(Number(bpm), Number(readArg(rest, "duration")) * 1000, Number(readArg(rest, "offset") ?? 0)) : await detectBeats(path.resolve(audio!));
      console.log(`[glint] beats: ~${grid.bpm} BPM, ${grid.beatsMs.length} 个节拍点`);
      if (readArg(rest, "out")) fs.writeFileSync(readArg(rest, "out")!, JSON.stringify(grid, null, 2));
      return;
    }
    case "audio-master": {
      const music = readArg(rest, "music"), out = readArg(rest, "out");
      if (!music || !out) throw new Error("audio-master requires --music=<file> and --out=<wav>");
      const { masterMusicBed } = await import("@glintai/music");
      const voice = readArg(rest, "voice");
      await masterMusicBed(path.resolve(music), voice ? path.resolve(voice) : null, path.resolve(out), { targetLufs: Number(readArg(rest, "lufs") ?? -14) });
      console.log(`[glint] mastered${voice ? " (ducked under voice)" : ""} → ${out}`);
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
    case "recipe":
    case "previz-controls":
    case "tasks":
      return (await import("./core-cli")).runCoreCommand(command, rest);
    case "comfyui": process.exitCode = await (await import("./comfyui-cli")).runComfyUI(rest); return;
    case "container": process.exitCode = await (await import("./container-cli")).runContainer(rest); return;
    case "session": {
      const { runSession } = await import("./session-cli");
      runSession(rest); return;
    }
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
          "  pnpm glint lint --project=project.json     分镜工艺 lint(空镜/连续推镜/字卡结尾/蓝紫)",
          "  pnpm glint render --project=p.json --scenes=s1,s2   子集重渲;--plate 出无字幕底片",
          "  pnpm glint qa --video=out/final.mp4        成片门禁(丰富度/静止/蓝紫/空画面/首帧)",
          "  pnpm glint nle --project=p.json --video=out.mp4 --format=fcpxml|edl   剪辑时间线(实验)",
          "  pnpm glint nle-render --project=nle.json --assets=media --out=out.mp4   多轨 NLE 成片；可选 --motion-samples=2|4|8 --shutter-angle=180（仅≤720p）",
          "  pnpm glint gltf-controls --project=p.json --scene=id [--clip=动作 --morph=表情=0.5 --out=new.json]   查看/设置模型动作和表情",
          "  pnpm glint html-template --project=p.json --scene=id [--append --headline=标题 --out=new.json]   查看/编辑本地 HTML 动效模板",
          "  pnpm glint render-env [--fonts=家族,家族]                渲染环境指纹与字体命中（近似）",
          "  pnpm glint render-env --font-lock-create=<新文件> --font-file=<字体文件> 记录字体 SHA-256，可重复指定文件",
          "  pnpm glint render-env --font-lock-verify=<锁文件> [--font-file=<字体文件>] 校验缺失或版本变化（不绑定渲染）",
          "  pnpm glint lottie-studio --project=p.json --scene=id [--source=animation.json]   本地参数编辑台（不执行动画）",
          "  pnpm glint lottie-import --inspect-source=animation.json   本地导入前只读检查",
          "  pnpm glint lottie-import --project=p.json --scene=id [--append --source=animation.json --out=new.json]   本地 Lottie 导入与参数",
          "  pnpm glint lottie-import --project=p.json --scene=id --save-assets=<素材库目录>   内嵌图片素材回库（魔数/大小校验，独占写不覆盖）",
          "  pnpm glint image-canvas --src=in.png --out=new.png --left=100 --right=100 [--color=#ffffff]   仅扩画布，不生成内容",
          "  pnpm glint alpha-frames --project=p.json --out=new-dir [--width=960 --height=540]   受限 SVG 透明 PNG 序列",
          "  pnpm glint alpha-webm --project=p.json --out=new.webm [--width=960 --height=540]   受限 SVG 透明 WebM（无音频）",
          "  pnpm glint look --video=out.mp4 --out=new-dir [--at=1 --start=0 --end=3]\n  pnpm glint project-migrate --project=old.json --out=new-dir --kind=scene-document|timeline-document",
          "  pnpm glint delivery-check --video=out.mp4 --audio=optional   最终文件解码与响度检查",
          "  pnpm glint verify-export --video=out.mp4 [--expect-width=1920 --expect-height=1080 --expect-fps=30 --expect-duration-ms=15000]   导出规格验证报告（自动项+未覆盖人工项）",
          "  pnpm glint packs [--query=商品] [--use=product-launch --out=new.json --params=inputs.json]   统一创作包",
          "  pnpm glint jianying --project=p.json --video=out.mp4   剪映草稿+SRT(实验)",
          "  pnpm glint srt|beats|audio-master|styles|templates",
          "  pnpm glint style-catalog samples [--dir=样片目录]   查看历史真实样片及校验状态",
          "  pnpm glint style-catalog archive --project=p.json --dir=历史目录   保存主题版本",
          "  pnpm glint style-catalog list --dir=历史目录 [--id=工程ID]   查看主题版本",
          "  pnpm glint style-catalog restore --project=p.json --source=版本文件 --out=新工程.json   恢复到新文件",
          "  pnpm glint session inspect|set|verify --project=...   产品/Skill 共用工程会话", "  pnpm glint container snapshot --id=... --endpoint=... | open|append|undo|redo --request=...",
          "  pnpm glint timeline --project=p.json                 查看共享修订与场景起点/时长",
          "  pnpm glint timeline --project=p.json --op=trim --scene=id --edge=end --delta-ms=100 --base-revision=0   事务化剪辑",
          "  pnpm glint plan --project=p.json --set='scenes[1].title=X'   预测本次改动的节点/费用/耗时",
          "  pnpm glint build --project=p.json --out=out.mp4 --assert-budget   渲染并写回执、核对预算",
          "  pnpm glint verify --receipt=out.mp4.receipt.json [--rebuild]     校验回执/哈希/环境漂移",
          "  pnpm glint diff --before=a.mp4 --after=b.mp4 --strict            帧级差异与变化区间",
          "  pnpm glint prove --project=p.json --tests=glint.tests.json       可机器判定的断言",
          "  pnpm glint apply --project=p.json --set='scene.title=X'           CAS 编辑工程",
          "  pnpm glint mcp                                        以 MCP stdio 提供 plan/apply/build/prove", "  pnpm glint comfyui submit|status|cancel|download --endpoint=...   本地 ComfyUI（提交需 --confirm-execute）",
          "  pnpm glint previz-controls --document=FILE --shot=ID --frame=0 --out=NEW_DIR",
          "  pnpm glint tasks list|status|cancel --family=media --id=ID [--confirm]",
          "  pnpm glint render|ask|rehearse|reexplain|studio",
        ].join("\n"),
      );
      if (command !== "help") process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

