import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { llmFromEnvironment } from "@glintai/llm";
import { parseProject } from "@glintai/scenescript";
import { reexplain } from "@glintai/listener";

/**
 * One-click re-explain: rewrite one scene for a real confusion.
 *
 *   pnpm --filter glint-studio reexplain --project=... --scene=life-negentropy --confusion="负熵是什么,听起来像科幻" [--write]
 */
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const projectPath = path.resolve(
    readArg("project") ?? "../../examples/entropy-lecture/project.scenescript.json",
  );
  const sceneId = readArg("scene");
  if (!sceneId) throw new Error('Pass a scene with --scene=<scene id>.');
  const project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  if (!process.env.GLINT_LLM_API_KEY) {
    throw new Error("Set GLINT_LLM_API_KEY (and optionally GLINT_LLM_BASE_URL / GLINT_LLM_MODEL).");
  }
  const llm = llmFromEnvironment();

  console.log(`[glint] re-explaining scene "${sceneId}"...`);
  const updated = await reexplain(project, llm, {
    sceneId,
    confusion: readArg("confusion"),
    timeoutMs: 150_000,
  });
  const scene = updated.scenes.find((entry) => entry.id === sceneId);
  console.log(JSON.stringify(scene, null, 2));

  if (process.argv.includes("--write")) {
    fs.writeFileSync(projectPath, JSON.stringify(updated, null, 2) + "\n");
    console.log(`\n[glint] written back to ${projectPath}`);
  } else {
    console.log("\n[glint] preview only — pass --write to persist.");
  }
}

main().catch((error: unknown) => {
  console.error(`[glint] reexplain failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
