import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { createCliRuntime, readArg, renderArgs, sourceInput } from "./glint-runtime";
import { styleRhythmIssues } from "./style-rhythm";
import { composeFromSource, isTemplateId, reviewProject, craftLint, lintVerdict } from "@glintai/composer";
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
  const beatGrid = await (await import("./beat-policy")).beatsForMake(args);
  // Multiple data sources share one editable SceneScript; workbook sheets are separate scenes.
  const sources = args.filter(a => a.startsWith("--source=")).map(a => a.slice(9));
  if (input.path && (/\.(csv|tsv|xlsx)$/i.test(input.path) || fs.statSync(input.path).isDirectory())) {
    const { tableProject } = await import("./table-sources");
    const table = await tableProject(sources, { title: readArg(args, "title"), kind: readArg(args, "kind"), id: readArg(args, "id"), language: readArg(args, "language"), aspect: readArg(args, "aspect") as SceneScriptProject["aspect"], sheet: readArg(args, "sheet"), python: readArg(args, "table-python") });
    const project = table.project;
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

  const backend = readArg(args, "backend") ?? "native";
  if (!["native", "reference"].includes(backend)) throw new Error("backend must be native or reference");
  if (beatGrid && backend === "reference") (await import("./beat-policy")).injectBeatGrid(project, beatGrid);
  const { repairPresentation } = await import("./presentation-repair");
  const repair = repairPresentation(project);
  project = repair.project;
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
  const normalized = command === "delivery-check" ? raw.map(arg => /^--audio=(required|optional|forbidden)$/.test(arg) ? arg.replace("--audio=", "--audio-policy=") : arg) : raw;
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
    case "packs": {
      const { runCreationPacks } = await import("./creation-packs-cli");
      runCreationPacks(rest);
      return;
    }
    case "delivery-check": {
      const { runDeliveryCheck } = await import("./delivery-check");
      await runDeliveryCheck(rest);
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
    case "image-edit": {
      const src = readArg(rest, "src"), out = readArg(rest, "out");
      const preset = readArg(rest, "preset");
      const prompt = readArg(rest, "prompt") ?? (preset ? (await import("./image-edit")).EDIT_PRESETS[preset] : undefined);
      if (!src || !out || !prompt) throw new Error("image-edit requires --src=<image> --out=<new image path> and (--prompt=\"改动\" 或 --preset=remove-bg|new-background|retouch|restore|upscale)");
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
      const { buildProjectCues, formatSrt } = await import("./jianying");
      const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
      const cues = buildProjectCues(project);
      const out = readArg(rest, "out") ?? path.join(STUDIO_DIR, "out", `${project.id}.srt`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, formatSrt(cues), "utf8");
      console.log(`[glint] ${cues.length} 条字幕 → ${out}`);
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
    case "session": {
      const { runSession } = await import("./session-cli");
      runSession(rest);
      return;
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
          "  pnpm glint nle-render --project=nle.json --assets=media --out=out.mp4   多轨 NLE 成片",
          "  pnpm glint delivery-check --video=out.mp4 --audio=optional   最终文件解码与响度检查",
          "  pnpm glint packs [--query=商品] [--use=product-launch --out=new.json --params=inputs.json]   统一创作包",
          "  pnpm glint jianying --project=p.json --video=out.mp4   剪映草稿+SRT(实验)",
          "  pnpm glint srt|beats|audio-master|styles|templates",
          "  pnpm glint session inspect|set|verify --project=...   产品/Skill 共用工程会话",
          "  pnpm glint timeline --project=p.json                 查看共享修订与场景起点/时长",
          "  pnpm glint timeline --project=p.json --op=trim --scene=id --edge=end --delta-ms=100 --base-revision=0   事务化剪辑",
          "  pnpm glint plan --project=p.json --set='scenes[1].title=X'   预测本次改动的节点/费用/耗时",
          "  pnpm glint build --project=p.json --out=out.mp4 --assert-budget   渲染并写回执、核对预算",
          "  pnpm glint verify --receipt=out.mp4.receipt.json [--rebuild]     校验回执/哈希/环境漂移",
          "  pnpm glint diff --before=a.mp4 --after=b.mp4 --strict            帧级差异与变化区间",
          "  pnpm glint prove --project=p.json --tests=glint.tests.json       可机器判定的断言",
          "  pnpm glint apply --project=p.json --set='scene.title=X'           CAS 编辑工程",
          "  pnpm glint mcp                                        以 MCP stdio 提供 plan/apply/build/prove",
          "  pnpm glint render|ask|rehearse|reexplain|studio",
        ].join("\n"),
      );
      if (command !== "help") process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

