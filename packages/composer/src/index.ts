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
export { planVisuals, describeVisualPlan, VisualPlanScene, VisualLayout, VisualRelation, VisualMotion } from "./visual-plan";
export type { VisualPlanScene as _VisualPlanScene, VisualLayout as _VisualLayout, VisualRelation as _VisualRelation, VisualMotion as _VisualMotion } from "./visual-plan";
export { validateBatchTable, applyTemplate, expandSceneGroups, estimateBatchBudget, scheduleBatch, resumeBatch, runChunked, BatchRow, type BatchIssue } from "./batch";
export { blindMetrics, blindCompare, scoreDistribution, type BlindMetrics } from "./blind";
export { splitScreenplay, type ScreenplaySplit, type DramaEpisode, type DramaCharacter } from "./drama";
export { transcribeAudio, segmentTranscript, type Transcript, type TranscriptSegment, type ChatAudioClient } from "./asr";
export { SHOT_CARDS, ENERGY_ARC, planEnergyArc, shotCardById } from "./shot-cards";
export type { ShotCard, ShotCategory, EnergyArcSlot } from "./shot-cards";
export { canonBrief, canonLint, parseCanonTable, unusedCanonEntries, CanonEntry, CanonTable, type CanonIssue } from "./canon";
