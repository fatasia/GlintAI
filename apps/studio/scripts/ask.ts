import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { AnswerEngine, loadMarkdown, LexicalKnowledgeBase } from "@glintai/knowledge";
import { llmFromEnvironment } from "@glintai/llm";

/**
 * Ask the project's knowledge source a question and print a grounded,
 * citation-backed answer — or an explicit refusal. Requires GLINT_LLM_* env.
 *
 *   pnpm --filter glint-studio ask --project=../../examples/entropy-lecture/project.scenescript.json --q="熵增原理的前提是什么?"
 */
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const question = readArg("q");
  const projectPath = path.resolve(
    readArg("project") ?? "../../examples/entropy-lecture/project.scenescript.json",
  );
  if (!question) {
    throw new Error('Pass a question with --q="your question".');
  }
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
    id: string;
    knowledgeSources: Array<{ name: string }>;
  };
  const sourcePath = path.join(path.dirname(projectPath), project.knowledgeSources[0]?.name ?? "source.md");
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Knowledge source not found: ${sourcePath}`);
  }

  const kb = new LexicalKnowledgeBase();
  kb.addDocument(loadMarkdown(fs.readFileSync(sourcePath, "utf8"), { docId: project.id }));
  if (!process.env.GLINT_LLM_API_KEY) {
    throw new Error("Set GLINT_LLM_API_KEY (and optionally GLINT_LLM_BASE_URL / GLINT_LLM_MODEL).");
  }
  const llm = llmFromEnvironment();

  const engine = new AnswerEngine({ kb, llm, topK: 4 });
  const answer = await engine.answer(question);
  console.log(`\nQ: ${question}\n`);
  if (answer.refused) {
    console.log(`A: (refused: ${answer.refusalReason}) — 该问题超出知识源范围,拒绝编造。`);
  } else {
    console.log(`A: ${answer.answer}\n`);
  }
  console.log("Sources:");
  for (const citation of answer.citations) {
    console.log(`  [${citation.docId}] ${citation.headingPath.join(" › ")} — ${citation.snippet}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[glint] ask failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
