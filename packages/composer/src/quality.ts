import type { SceneScriptProject } from "@glintai/scenescript";
import { splitSentences } from "./parsing";

export type ReviewFlag = "no-candidate" | "number-mismatch" | "negation-mismatch" | "repeated" | "term-variant";
export interface EvidenceCandidate { start: number; end: number; text: string; score: number }
export interface SentenceReview { sceneId: string; text: string; flags: ReviewFlag[]; candidates: EvidenceCandidate[] }

const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
function tokens(text: string): Set<string> {
  const result = new Set(text.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []);
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) result.add(run);
    for (let i = 0; i < run.length - 1; i++) result.add(run.slice(i, i + 2));
  }
  return result;
}
function overlap(a: Set<string>, b: Set<string>): number {
  return a.size ? [...a].filter((token) => b.has(token)).length / a.size : 0;
}
const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)*(?:%|％)?/g) ?? []).sort().join("|");
const negated = (text: string) => /不|未|无|没有|并非|禁止|\b(?:not|never|no|cannot|without)\b|n't/iu.test(text);

/** Lexical evidence candidates, not a factual verdict. Offsets refer to the supplied source. */
export function reviewProject(project: SceneScriptProject, source: string, options: { terms?: string[][] } = {}) {
  let offset = 0;
  const spans = splitSentences(source).map((text) => {
    const start = source.indexOf(text, offset);
    offset = Math.max(offset, start + text.length);
    return { start, end: start + text.length, text, tokens: tokens(text) };
  }).filter((span) => span.start >= 0);
  const seen = new Set<string>();
  const sentences: SentenceReview[] = [];
  const allNarration = project.scenes.map((scene) => scene.narration.text).join("\n");
  for (const scene of project.scenes) for (const text of splitSentences(scene.narration.text)) {
    const normalized = normalize(text);
    const query = tokens(text);
    const candidates = spans.map(({ tokens: candidateTokens, ...span }) => ({
      ...span, score: normalize(span.text).includes(normalized) ? 1 : overlap(query, candidateTokens),
    })).filter((span) => span.score >= 0.3).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 3);
    const flags: ReviewFlag[] = [];
    const best = candidates[0];
    if (!best) flags.push("no-candidate");
    if (best && numbers(text) !== numbers(best.text)) flags.push("number-mismatch");
    if (best && negated(text) !== negated(best.text)) flags.push("negation-mismatch");
    if (seen.has(normalized)) flags.push("repeated");
    seen.add(normalized);
    if (options.terms?.some((aliases) => aliases.filter((term) => allNarration.includes(term)).length > 1 && aliases.some((term) => text.includes(term)))) flags.push("term-variant");
    sentences.push({ sceneId: scene.id, text, flags, candidates });
  }
  return {
    version: 1 as const,
    basis: "词汇匹配候选；匹配不等于事实正确，数字、否定与术语提示需人工核对。",
    sourceChars: source.length,
    flagged: sentences.filter((sentence) => sentence.flags.length > 0).length,
    sentences,
  };
}
