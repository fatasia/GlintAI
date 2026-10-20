import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { OpenAICompatibleProvider } from "@glintai/llm";
import { parseProject } from "@glintai/scenescript";
import { defaultPersonas, rehearse, parsePersonaPack } from "@glintai/listener";

/**
 * Virtual-listener rehearsal: personas listen to the narration and raise
 * scene-mapped confusions before anything is published.
 *
 *   pnpm --filter glint-studio rehearse --project=../../examples/entropy-lecture/project.scenescript.json
 */
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const projectPath = path.resolve(
    readArg("project") ?? "../../examples/entropy-lecture/project.scenescript.json",
  );
  const project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  if (!process.env.GLINT_LLM_API_KEY) {
    throw new Error("Set GLINT_LLM_API_KEY (and optionally GLINT_LLM_BASE_URL / GLINT_LLM_MODEL).");
  }
  const llm = new OpenAICompatibleProvider({
    baseUrl: process.env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.GLINT_LLM_API_KEY,
    model: process.env.GLINT_LLM_MODEL ?? "glm-4",
  });

  const personaArg = readArg("personas");
  const personaPack = readArg("persona-pack");
  const available = personaPack ? parsePersonaPack(JSON.parse(fs.readFileSync(personaPack, "utf8"))) : defaultPersonas(project.language);
  const personas = personaArg
    ? available.filter((persona) =>
        personaArg.split(",").includes(persona.id),
      )
    : available;
  if (personas.length === 0) {
    throw new Error(
      `Unknown persona filter "${personaArg}". Available: ${defaultPersonas(project.language).map((persona) => persona.id).join(", ")}`,
    );
  }

  console.log(`[glint] rehearsing "${project.title}" with ${personas.length} listeners...`);
  const reports = await rehearse(project, llm, { personas, timeoutMs: 150_000 });

  for (const report of reports) {
    console.log(`\n=== ${report.persona.name} (${report.persona.id}) ===`);
    if (report.confusions.length === 0) {
      console.log("  全程听懂,没有卡住的地方。");
      continue;
    }
    for (const confusion of report.confusions) {
      console.log(`  [${confusion.sceneId}] ${confusion.confusion}`);
      if (confusion.suggestion) console.log(`    ↳ 建议:${confusion.suggestion}`);
    }
  }

  const outArg = readArg("out");
  if (outArg) {
    const outPath = path.resolve(outArg);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(reports, null, 2));
    console.log(`\n[glint] report saved: ${outPath}`);
  }
  const total = reports.reduce((sum, report) => sum + report.confusions.length, 0);
  console.log(`\n[glint] ${total} confusion(s) across ${reports.length} listener(s).`);
}

main().catch((error: unknown) => {
  console.error(`[glint] rehearse failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
