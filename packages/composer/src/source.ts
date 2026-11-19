import type { LlmProvider } from "@glintai/llm";
import { readSourceText, SourceError, type SourceOptions } from "@glintai/knowledge";
import { composeCodeSurvey, surveyCodeRepo } from "./code-repo";
import { ComposerError, composeFromMarkdown, type ComposerOptions } from "./heuristic";
import { composeWithLlm } from "./llm";
import type { SceneScriptProject } from "@glintai/scenescript";
import { templateById } from "./templates";
import { validateComposerOptions } from "./heuristic";
import { createCreativeBrief, creativeBriefPrompt, type CreativeBrief } from "./creative-brief";

export interface SourceInput {
  /** UTF-8 md/txt/html/json/csv or a text PDF file; relative to the caller's cwd. */
  path?: string;
  /** http(s) page or pdf. */
  url?: string;
  /** Creative request — expanded without discarding the original intent. */
  idea?: string;
  /** Repository directory — surveyed into a code-walkthrough outline. */
  code?: string;
}

export interface ComposedSource {
  project: SceneScriptProject;
  /** The material the scenes were composed from (audit trail). */
  sourceText: string;
  sourceName: string;
  creativeBrief?: CreativeBrief;
}

/**
 * A composed film should not open on a frozen slide. Scenes that do not ask for
 * a specific camera get a gentle one-pass drift (ends where it starts), which
 * raises measured frame change without moving text out of the safe area.
 */
function withDefaultMotion(project: SceneScriptProject): SceneScriptProject {
  return {
    ...project,
    scenes: project.scenes.map(scene => scene.camera || scene.kind === "html" || scene.kind === "three"
      ? scene
      : { ...scene, camera: { type: "drift", intensity: 0.35 } }),
  };
}

const IDEA_SYSTEM = [
  "你是 Glint 的编剧。把用户创作要求扩写成可拍摄的 Markdown 内容稿，而不是一律写成教学文档。",
  "用一个 H1 标题；按意图安排必要的段落或镜头节拍，H2 与篇幅按内容需要，不固定小节数，不因输入短就套课件，不因输入长就重复。",
  "语言跟随原始要求：英文输入用英文，明确指定语言时按指定语言。保留品牌名、原句、时长、语气和风格限制。",
  "分清可说的内容与画面构想；有必要时将视觉意象标成画面建议，不把导演说明写成旁白。",
  "可以创造文案、视觉类比与情绪节奏，不能编造事实、数值、引语、效果保证或真实案例；缺少产品参数时不要替用户补卖点。",
  "画面应能用现有 title/comparison/diagram/chart/image 与可编辑文字、形状表达：图表只用已给数字，image 只用已提供真实本地素材；无素材则描述构图，不承诺生成图片。禁止要求 HTML、脚本或 3D。",
].join("\n");

export async function expandIdeaToSource(
  originalRequest: string,
  llm: LlmProvider,
  options: ComposerOptions = {},
  signal?: AbortSignal,
): Promise<{ sourceText: string; creativeBrief: CreativeBrief }> {
  validateComposerOptions(options);
  const creativeBrief = createCreativeBrief(originalRequest);
  signal?.throwIfAborted();
  const template = templateById(options.template);
  const response = await llm.chat({
    system: [IDEA_SYSTEM, creativeBriefPrompt(creativeBrief), `Output options: ${JSON.stringify(options)}`,
      template ? `显式模板结构合同：${JSON.stringify(template)}。仅使用有依据的资料满足结构，不得为了通过模板虚构结果、日期、代码或案例。` : "未指定模板，按原指令选创作结构，不默认 explainer。",
    ].join("\n"),
    temperature: 0.7,
    timeoutMs: 150_000,
    signal,
    messages: [{ role: "user", content: originalRequest }],
  });
  signal?.throwIfAborted();
  return { sourceText: response.text, creativeBrief };
}

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
    const project = withDefaultMotion(composeCodeSurvey(survey, options));
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
    const { sourceText, creativeBrief } = await expandIdeaToSource(input.idea, llm, options, sourceOptions.signal);
    const project = withDefaultMotion(await composeWithLlm(sourceText, llm, options, { signal: sourceOptions.signal, creativeBrief }));
    return { project, sourceText, sourceName: "idea.md", creativeBrief };
  }
  if (input.path || input.url) {
    const text = await readSourceText({ path: input.path, url: input.url }, sourceOptions);
    if (!text.trim()) {
      throw new SourceError("Source is empty after extraction.");
    }
    const sourceName = input.url ?? (input.path ? input.path.split(/[\\/]/).pop()! : "source.md");
    const project = withDefaultMotion(
      llm && options.useLlm
        ? await composeWithLlm(text, llm, { ...options, sourceName: options.sourceName ?? sourceName }, { signal: sourceOptions.signal })
        : composeFromMarkdown(text, { ...options, sourceName: options.sourceName ?? sourceName }),
    );
    return { project, sourceText: text, sourceName };
  }
  throw new ComposerError(
    "Nothing to compose: pass one of --source=<file|url>, --idea=\"...\" or --code=<repo dir>.",
  );
}
