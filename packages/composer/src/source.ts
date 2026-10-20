import type { LlmProvider } from "@glintai/llm";
import { readSourceText, SourceError, type SourceOptions } from "@glintai/knowledge";
import { composeCodeSurvey, surveyCodeRepo } from "./code-repo";
import { ComposerError, composeFromMarkdown, type ComposerOptions } from "./heuristic";
import { composeWithLlm } from "./llm";
import type { SceneScriptProject } from "@glintai/scenescript";
import { templateById } from "./templates";
import { validateComposerOptions } from "./heuristic";

export interface SourceInput {
  /** UTF-8 md/txt/html/json/csv or a text PDF file; relative to the caller's cwd. */
  path?: string;
  /** http(s) page or pdf. */
  url?: string;
  /** One-sentence idea — expanded into a teaching outline by the LLM. */
  idea?: string;
  /** Repository directory — surveyed into a code-walkthrough outline. */
  code?: string;
}

export interface ComposedSource {
  project: SceneScriptProject;
  /** The teaching document the scenes were composed from (audit trail). */
  sourceText: string;
  sourceName: string;
}

const IDEA_SYSTEM = [
  "你是一支讲解视频的编剧。把用户的一句话想法,扩写成一份可以直接拍摄的中文教学文档。",
  "要求:Markdown;一个 H1 标题;4-6 个 H2 小节;每小节 2-4 句;用具体例子和类比;不编造事实性数据。",
  "如果想法是英文,则全文用英文。",
].join("\n");

export async function composeFromSource(
  input: SourceInput,
  llm: LlmProvider | undefined,
  options: ComposerOptions = {},
  sourceOptions: SourceOptions = {},
): Promise<ComposedSource> {
  validateComposerOptions(options);
  if ([input.path, input.url, input.idea, input.code].filter((value) => value !== undefined).length !== 1) {
    throw new ComposerError("Provide exactly one of source, url, idea or code");
  }
  if (Object.values(input).some((value) => typeof value === "string" && !value.trim())) throw new ComposerError("Source input cannot be blank");
  if (options.maxScenes !== undefined && (!Number.isInteger(options.maxScenes) || options.maxScenes < 1 || options.maxScenes > 100)) throw new ComposerError("maxScenes must be 1..100");
  if (input.code) {
    const survey = surveyCodeRepo(input.code, options);
    const project = composeCodeSurvey(survey, options);
    return {
      project,
      sourceText: survey.markdown,
      sourceName: "code-survey",
    };
  }
  if (input.idea) {
    if (!llm) {
      throw new ComposerError(
        "--idea needs an LLM. Set GLINT_LLM_* env vars, or pass a --source file instead.",
      );
    }
    const response = await llm.chat({
      system: `${IDEA_SYSTEM}\n选定模板及资料结构要求：${JSON.stringify(templateById(options.template) ?? "explainer")}。不具备资料依据的实验结果、案例、日期不得编造，资料不足时明确指出。`,
      temperature: 0.7,
      timeoutMs: 150_000,
      signal: sourceOptions.signal,
      messages: [{ role: "user", content: input.idea }],
    });
    const project = await composeWithLlm(response.text, llm, options, { signal: sourceOptions.signal });
    return { project, sourceText: response.text, sourceName: "idea.md" };
  }
  if (input.path || input.url) {
    const text = await readSourceText({ path: input.path, url: input.url }, sourceOptions);
    if (!text.trim()) {
      throw new SourceError("Source is empty after extraction.");
    }
    const sourceName = input.url ?? (input.path ? input.path.split(/[\\/]/).pop()! : "source.md");
    const project =
      llm && options.useLlm
        ? await composeWithLlm(text, llm, { ...options, sourceName: options.sourceName ?? sourceName }, { signal: sourceOptions.signal })
        : composeFromMarkdown(text, { ...options, sourceName: options.sourceName ?? sourceName });
    return { project, sourceText: text, sourceName };
  }
  throw new ComposerError(
    "Nothing to compose: pass one of --source=<file|url>, --idea=\"...\" or --code=<repo dir>.",
  );
}
