import type { WordTiming } from "./types";

const CJK_CHAR =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

const CJK_CHAR_WEIGHT = 1;
const OTHER_CHAR_WEIGHT = 0.55;
const PUNCT_CHAR_WEIGHT = 0.25;

/**
 * Speech pace expressed in CJK-equivalent characters per second at
 * speakingRate 1.0. Calibrated against common zh-CN TTS voices; revise
 * after real-voice measurement (M1).
 */
export const DEFAULT_CJK_CHARS_PER_SECOND = 4.6;

export const MIN_SCENE_DURATION_MS = 800;

function charWeight(ch: string): number {
  if (CJK_CHAR.test(ch)) return CJK_CHAR_WEIGHT;
  if (/\s/.test(ch)) return 0;
  if (/[.,!?;:'"()[\]{}、。，！？；：（）【】《》“”‘’…—·\-/]/.test(ch)) {
    return PUNCT_CHAR_WEIGHT;
  }
  return OTHER_CHAR_WEIGHT;
}

export function textWeight(text: string): number {
  let weight = 0;
  for (const ch of text) weight += charWeight(ch);
  return weight;
}

export interface EstimateOptions {
  speakingRate?: number;
}

/** Duration estimate in ms, rounded to 10ms, never below the scene minimum. */
export function estimateNarrationDurationMs(
  text: string,
  options?: EstimateOptions,
): number {
  if (!text.trim()) {
    throw new Error("Cannot estimate duration of empty narration text");
  }
  const rate = Math.min(2, Math.max(0.5, options?.speakingRate ?? 1));
  const seconds = textWeight(text) / (DEFAULT_CJK_CHARS_PER_SECOND * rate);
  const ms = Math.round((seconds * 1000) / 10) * 10;
  return Math.max(MIN_SCENE_DURATION_MS, ms);
}

interface SpeechToken {
  text: string;
  weight: number;
}

const SPEECH_TOKEN =
  /[a-zA-Z0-9]+(?:['’][a-zA-Z]+)*|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]|[^\sa-zA-Z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

export function tokenizeSpeech(text: string): string[] {
  return [...text.matchAll(SPEECH_TOKEN)]
    .map((match) => match[0])
    .filter((token): token is string => token !== undefined);
}

/**
 * Distributes `durationMs` across speech tokens proportionally to their
 * spoken weight. Timings are gap-free, monotonically increasing, and the
 * final token ends exactly at `durationMs`.
 */
export function estimateWordTimings(
  text: string,
  durationMs: number,
): WordTiming[] {
  const tokens = tokenizeSpeech(text);
  if (tokens.length === 0 || !(durationMs > 0)) return [];

  const weights = tokens.map((token) => {
    let weight = 0;
    for (const ch of token) weight += charWeight(ch);
    return weight;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    const per = Math.max(1, Math.floor(durationMs / tokens.length));
    return tokens.map((token, index) => ({
      text: token,
      startMs: index * per,
      endMs: index === tokens.length - 1 ? durationMs : (index + 1) * per,
    }));
  }

  const timings: WordTiming[] = [];
  let cumulative = 0;
  let lastEnd = 0;
  for (let index = 0; index < tokens.length; index++) {
    cumulative += weights[index] ?? 0;
    const isLast = index === tokens.length - 1;
    let end = isLast
      ? durationMs
      : Math.round((cumulative / totalWeight) * durationMs);
    if (end <= lastEnd) end = lastEnd + 1;
    if (end > durationMs) end = durationMs;
    timings.push({ text: tokens[index] ?? "", startMs: lastEnd, endMs: end });
    lastEnd = end;
    if (lastEnd >= durationMs && !isLast) {
      // Ran out of room due to rounding: merge the remainder implicitly.
      for (let j = index + 1; j < tokens.length; j++) {
        const prev = timings[timings.length - 1];
        const token = tokens[j] ?? "";
        if (prev && prev.text === token) {
          prev.endMs = durationMs;
        } else {
          timings.push({
            text: token,
            startMs: Math.max(0, durationMs - 1),
            endMs: durationMs,
          });
        }
      }
      break;
    }
  }
  return timings;
}
