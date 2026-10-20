import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeFromMarkdown, composeWithLlm, reviewProject, TEMPLATES } from "../packages/composer/src/index.ts";
import { buildTimeline } from "../packages/scenescript/src/timeline.ts";
import { OpenAICompatibleProvider } from "../packages/llm/src/index.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(fs.readFileSync(path.join(root, "examples/evaluation/cases.json"), "utf8"));
const live = process.env.GLINT_EVAL_LIVE === "1";
if (live && !process.env.GLINT_LLM_API_KEY) throw new Error("Live evaluation needs GLINT_LLM_API_KEY");
const provider = live ? new OpenAICompatibleProvider({ baseUrl: process.env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", apiKey: process.env.GLINT_LLM_API_KEY, model: process.env.GLINT_LLM_MODEL ?? "glm-4", reasoningEffort: process.env.GLINT_LLM_REASONING_EFFORT }) : null;
const out = process.env.GLINT_QUALITY_OUT ?? path.join(root, "quality-report.json");
const artifacts = `${out}.cases`;
fs.mkdirSync(artifacts, { recursive: true });
const results = [];
for (const item of cases) {
  const started = performance.now();
  const replies = [];
  const measuredProvider = provider && { name: provider.name, async chat(request) { const result = await provider.chat(request); replies.push(result.text); return result; } };
  try {
    const options = { projectId: item.id, template: item.template, maxScenes: 8 };
    const project = measuredProvider ? await composeWithLlm(item.source, measuredProvider, options) : composeFromMarkdown(item.source, options);
    const review = reviewProject(project, item.source), timeline = buildTimeline(project), template = TEMPLATES.find(entry => entry.id === item.template);
    const body = project.scenes.slice(1);
    const checks = {
      boundedScenes: project.scenes.length >= 2 && project.scenes.length <= 8,
      startsWithTitle: project.scenes[0].kind === "title",
      language: project.language === item.language,
      positiveDuration: timeline.totalMs > 0,
      requiredKind: !template.requiredKind || body.some(scene => scene.kind === template.requiredKind),
      compatibleKinds: !template.bodyKinds || body.every(scene => template.bodyKinds.includes(scene.kind)),
    };
    fs.writeFileSync(path.join(artifacts, `${item.id}.json`), JSON.stringify({ source: item.source, project, replies }, null, 2));
    results.push({ id: item.id, checks, calls: replies.length, repairs: Math.max(0, replies.length - 1), elapsedMs: performance.now() - started, scenes: project.scenes.length, durationMs: timeline.totalMs, reviewSentences: review.sentences.length, flaggedSentences: review.flagged, review, passed: Object.values(checks).every(Boolean) });
  } catch (error) {
    fs.writeFileSync(path.join(artifacts, `${item.id}.json`), JSON.stringify({ source: item.source, replies }, null, 2));
    results.push({ id: item.id, calls: replies.length, passed: false, error: error?.name === "ComposerError" ? error.message : "Upstream transport/timeout failure; provider response omitted" });
  }
  console.log(`[quality] ${item.id}: ${results.at(-1).passed ? "passed" : "FAILED"}; calls=${replies.length}`);
  fs.writeFileSync(out, JSON.stringify({ status: "running", cases: results }, null, 2));
}
const base = composeFromMarkdown("# Review\n\nWater boils at 100 degrees.");
const guards = [
  { id: "changed-number", narration: "Water boils at 900 degrees.", source: "Water boils at 100 degrees.", flag: "number-mismatch" },
  { id: "reversed-negation", narration: "This method is effective.", source: "This method is not effective.", flag: "negation-mismatch" },
  { id: "unrelated-claim", narration: "Galaxies contain stars.", source: "Water boils.", flag: "no-candidate" },
].map(item => {
  const project = structuredClone(base); project.scenes = [project.scenes[0]]; project.scenes[0].narration.text = item.narration;
  return { id: item.id, passed: reviewProject(project, item.source).sentences.some(sentence => sentence.flags.includes(item.flag)) };
});
const report = { version: 3, generatedAt: new Date().toISOString(), engine: live ? provider.name : "offline-deterministic", artifacts, methodology: "24 authored synthetic cases, all 12 templates in Chinese/English; schema/template/timing/language gates plus 3 controlled mutation guards. Generated projects and replies are saved for review. Evidence flags are diagnostic, not human quality or factual scores.", cases: results, mutationGuards: guards, humanEvaluation: "not performed", passed: results.every(item => item.passed) && guards.every(item => item.passed) };
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`[quality] ${results.filter(item => item.passed).length}/${results.length} contracts; ${guards.filter(item => item.passed).length}/${guards.length} mutation guards; engine=${report.engine}; report=${out}`);
if (!report.passed) { console.log(JSON.stringify(results.filter(item => !item.passed), null, 2)); process.exitCode = 1; }
