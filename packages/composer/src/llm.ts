import { parseProject, SCENESCRIPT_VERSION, type SceneScriptProject } from "@glintai/scenescript";
import type { LlmProvider } from "@glintai/llm";
import { ComposerError, validateComposerOptions, type ComposerOptions } from "./heuristic";
import { parseMarkdown } from "./parsing";
import { requireTemplateSource } from "./strategies";
import { templateById } from "./templates";

export const DEFAULT_MAX_SOURCE_CHARS = 12000;

const SYSTEM_PROMPT = [
  "You are Glint's director. Turn the source material into a SceneScript explainer project.",
  "Output ONLY a single JSON object — no prose, no code fences.",
  "",
  "默认叙事建议（指定模板时以模板合同为准）:",
  "1. hook(title):第一句旁白必须给听众一个'为什么要听'的理由或反直觉钩子,禁止'今天我们来聊聊'式开场。",
  "2. 讲清 1-2 个核心概念(definition/bullets):每场景只讲一个概念。",
  "3. 至少一个具象化场景:用对比(comparison)、流程(diagram 式 bullets)或生活类比把抽象概念落到画面上;类比必须来自常识(扑克牌、厨房、天气),不来自资料外的专业领域。",
  "4. 收尾回扣开头的钩子,给一句可带走的结论。",
  "",
  "硬性规则:",
  "- 默认最多 8 个场景，用户指定 maxScenes 时包含标题在内不得超过上限。首场景为 title。",
  "- 旁白是口语:短句、主动语态、每句只一个信息点;禁止书面语连接词(综上所述/首先其次)。",
  "- 场景类型多样化:title | bullets | definition | quote | comparison | code;相邻场景不得同类型。",
  "- 全部内容与语言跟随资料:中文资料→中文输出,英文资料→英文输出。",
  "- 一切事实、数字、引语只能来自资料;资料没有就不要写,宁可少讲不可编造。",
  "- 引语如果使用 quote 场景,必须是资料中原句并附 attribution。",
  "- schemaVersion 必须是 " + String(SCENESCRIPT_VERSION) + ";每个 scene 唯一 kebab-case id。",
  "",
  "Shape:",
  `{"schemaVersion":${SCENESCRIPT_VERSION},"id":"kebab-id","title":"...","aspect":"16:9","knowledgeSources":[],"scenes":[{"id":"intro","kind":"title","title":"...","subtitle":"...","narration":{"text":"..."}},{"id":"kebab-id","kind":"bullets","heading":"...","items":["..."],"narration":{"text":"..."}}]}`,
].join("\n");

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ComposerError(
      "Model did not return a JSON object.",
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new ComposerError(
      `Model returned malformed JSON (${error instanceof Error ? error.message : String(error)}). Retry, or fall back to --engine=heuristic.`,
    );
  }
}

/**
 * LLM-directed composer for any OpenAI-compatible model (GLM, Qwen,
 * DeepSeek, ...). Output is strictly validated as SceneScript; the model
 * is instructed to stay inside the source material.
 */
export async function composeWithLlm(
  source: string,
  llm: LlmProvider,
  options: ComposerOptions = {},
  recovery: { repairAttempts?: number; signal?: AbortSignal } = {},
): Promise<SceneScriptProject> {
  const attempts = recovery.repairAttempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 2) throw new ComposerError("repairAttempts must be 0..2");
  validateComposerOptions(options);
  if (!source.trim()) throw new ComposerError("Source document is empty; nothing to compose.");
  if (source.length > DEFAULT_MAX_SOURCE_CHARS) throw new ComposerError(`Source exceeds ${DEFAULT_MAX_SOURCE_CHARS} characters; split the document before model composition.`);
  const template = templateById(options.template);
  if (template) requireTemplateSource(parseMarkdown(source, options.title).sections, template.id);
  for (let attempt = 0; ; attempt++) {
    recovery.signal?.throwIfAborted();
    try { return await composeOnce(source, llm, options, recovery.signal, attempt > 0); }
    catch (error) {
      if (!(error instanceof ComposerError) || attempt >= attempts || recovery.signal?.aborted) throw error;
    }
  }
}

async function composeOnce(source: string, llm: LlmProvider, options: ComposerOptions, signal?: AbortSignal, repair = false): Promise<SceneScriptProject> {
  validateComposerOptions(options);
  if (!source.trim()) {
    throw new ComposerError("Source document is empty; nothing to compose.");
  }
  const template = templateById(options.template);
  if (template) requireTemplateSource(parseMarkdown(source, options.title).sections, template.id);
  const response = await llm.chat({
    system: `${SYSTEM_PROMPT}\nOutput options: ${JSON.stringify(options)}\n${template ? `Template contract: ${JSON.stringify(template)}. Body scenes must include requiredKind when there is room; obey bodyKinds if specified.` : ""}\n${repair ? "The previous reply failed schema/template validation. Rebuild a minimal valid JSON object from the SAME source. Check every required field and unique scene id. Do not invent missing facts." : ""}`,
    signal,
    timeoutMs: 60_000,
    json: true,
    temperature: 0.3,
    messages: [
      {
        role: "user",
        content: `Source material / 源材料:\n\n${source}`,
      },
    ],
  });
  const candidate = extractJsonObject(response.text) as Record<string, unknown>;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new ComposerError("Model output must be an object");
  if (options.projectId) candidate.id = options.projectId;
  if (options.title) candidate.title = options.title;
  if (options.language) candidate.language = options.language;
  else if (typeof candidate.language !== "string" || !candidate.language) {
    // Models often omit the field; fall back to detection so pacing is right.
    const cjk = source.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
    const latin = source.match(/[a-zA-Z]/g)?.length ?? 0;
    const total = cjk + latin;
    candidate.language = total > 0 && cjk / total >= 0.15 ? "zh-CN" : "en-US";
  }
  candidate.schemaVersion = SCENESCRIPT_VERSION;
  candidate.aspect = options.aspect ?? candidate.aspect ?? "16:9";
  candidate.theme = options.theme ?? candidate.theme ?? "glint-dark";
  candidate.fps = options.fps ?? candidate.fps ?? 30;
  if (Array.isArray(candidate.scenes)) {
    const scenes = candidate.scenes.slice(0, options.maxScenes ?? 8);
    if (options.title && scenes[0]?.kind === "title") scenes[0].title = options.title;
    candidate.scenes = scenes;
  }
  if (!Array.isArray(candidate.knowledgeSources)) {
    candidate.knowledgeSources = [];
  }
  try {
    const project = parseProject(candidate);
    if (project.scenes[0]?.kind !== "title") throw new ComposerError("First scene must be title");
    const body = project.scenes.slice(1);
    if (template && (options.maxScenes ?? 8) > 1) {
      if (template.requiredKind && !body.some((s) => s.kind === template.requiredKind)) throw new ComposerError(`Template ${template.id} requires ${template.requiredKind}`);
      if (template.bodyKinds && body.some((s) => !template.bodyKinds!.includes(s.kind))) throw new ComposerError(`Template ${template.id} has incompatible body scenes`);
    }
    if (options.sourceName) project.knowledgeSources = [{ id: "source", kind: "markdown", name: options.sourceName }];
    return project;
  } catch (error) {
    throw new ComposerError(
      `Model output failed SceneScript validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
