export {
  composeFromMarkdown,
  ComposerError,
  type ComposerOptions,
} from "./heuristic";
export { composeWithLlm, DEFAULT_MAX_SOURCE_CHARS } from "./llm";
export { reviewProject, type SentenceReview, type ReviewFlag, type EvidenceCandidate } from "./quality";
export { craftLint, lintVerdict, isSlopBackground, type LintIssue } from "./craft-lint";
export { chartScenesFromTable, type TableChartResult } from "./chart-table";
export { composeFromCodeRepo, surveyCodeRepo, type CodeFile, type SurveyOptions } from "./code-repo";
export { composeFromSource, type SourceInput, type ComposedSource } from "./source";
export { TEMPLATES, THEME_IDS, isTemplateId, templateById, type TemplateId, type SceneTemplate } from "./templates";
export { analyzeCodeRepo, type CodeGraph, type GraphNode } from "./code-graph";
export { VideoPlan, PlanScene, parsePlanReply, planToSource, PLAN_SYSTEM, type VideoPlan as _VideoPlan } from "./plan";
