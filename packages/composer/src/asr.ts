import { z } from "zod";

/**
 * ASR via multimodal chat (the media gateway has no dedicated ASR model; gem-3.8-flash
 * accepts OpenAI-style audio input and transcribes reliably — verified against
 * a doubao TTS sample, 2026-10-24). The model returns plain text; word-level
 * timecodes are approximated by proportional alignment over the measured audio
 * duration (ffprobe), split on punctuation. Honest label: alignment is an
 * estimate, not model-emitted timestamps.
 */

export const TranscriptSegment = z.object({
  /** Segment start/end in ms, proportional estimate over audio duration. */
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().min(1),
  /** Speaker label for the turn (AUDIO-03 diarization; model-classified). */
  speaker: z.string().max(40).optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const Transcript = z.object({
  text: z.string().min(1),
  durationMs: z.number().int().min(1),
  segments: z.array(TranscriptSegment).min(1).max(500),
  engine: z.string().min(1),
  /** true when timecodes came from the ASR model itself (currently never). */
  modelTimed: z.literal(false),
  /** true when the model classified speaker turns (AUDIO-03). */
  diarized: z.boolean().default(false),
});
export type Transcript = z.infer<typeof Transcript>;

export interface ChatAudioClient {
  chat(request: { system?: string; messages: Array<{ role: string; content: Array<{ type: "text"; text: string } | { type: "input_audio"; input_audio: { data: string; format: string } }> }>; json?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<{ text: string }>;
}

const SEGMENT_SYSTEM = "你是听写引擎。转写音频中的全部中文/英文语音，只输出转写文本本身（含标点），不要任何说明、角色或时间戳。";
const DIARIZE_SYSTEM = "你是语音分析引擎。听出音频里有几个不同的说话人，按发言顺序转写。只输出 JSON 数组，每个元素 {\"speaker\":\"说话人A|说话人B|...\",\"text\":\"该轮完整转写(含标点)\"}；不要任何其他说明。";

/** Split on terminal punctuation into caption-sized segments (aim ≤ 18 chars). */
export function segmentTranscript(text: string, durationMs: number): TranscriptSegment[] {
  const clean = text.trim();
  if (!clean) throw new Error("ASR returned empty text");
  const pieces = clean.split(/(?<=[。！？；.!?;])/).map(piece => piece.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && (last + piece).length <= 18) merged[merged.length - 1] = last + piece;
    else if (last && piece.length < 6) merged[merged.length - 1] = last + piece;
    else merged.push(piece);
  }
  const totalChars = merged.reduce((sum, piece) => sum + piece.length, 0);
  let cursor = 0;
  return merged.map(piece => {
    const span = piece.length / totalChars * durationMs;
    const startMs = Math.round(cursor), endMs = Math.min(durationMs, Math.round(cursor + span));
    cursor = endMs;
    return { startMs, endMs, text: piece };
  });
}

/** Full path: audio bytes → multimodal chat → segmented transcript.
 * `diarize: true` asks the model to classify speaker turns first; turn texts
 * are then proportionally aligned over the measured duration (turn order and
 * text are model facts, per-turn timecodes remain estimates). */
export async function transcribeAudio(options: { audio: Uint8Array; format: "wav" | "mp3" | "webm"; durationMs: number; model: string; client: ChatAudioClient; diarize?: boolean; signal?: AbortSignal }): Promise<Transcript> {
  const data = Buffer.from(options.audio).toString("base64");
  if (options.diarize) {
    const response = await options.client.chat({
      system: DIARIZE_SYSTEM,
      messages: [{ role: "user", content: [
        { type: "text", text: "按说话人轮次转写音频。" },
        { type: "input_audio", input_audio: { data, format: options.format } },
      ] }],
      json: true,
      timeoutMs: 180_000,
      signal: options.signal,
    });
    let turns: Array<{ speaker?: string; text?: string }> = [];
    try {
      const parsed = JSON.parse(response.text.replace(/^```(?:json)?|```$/g, "").trim());
      if (Array.isArray(parsed)) turns = parsed;
      else if (Array.isArray(parsed?.turns)) turns = parsed.turns;
    } catch { /* fall through to plain transcript */ }
    const clean = turns.map(turn => ({ speaker: String(turn.speaker ?? "").slice(0, 40), text: String(turn.text ?? "").trim() })).filter(turn => turn.text);
    if (clean.length) {
      const totalChars = clean.reduce((sum, turn) => sum + turn.text.length, 0);
      let cursor = 0;
      const segments = clean.map(turn => {
        const span = turn.text.length / totalChars * options.durationMs;
        const startMs = Math.round(cursor), endMs = Math.min(options.durationMs, Math.round(cursor + span));
        cursor = endMs;
        return { startMs, endMs, text: turn.text, ...(turn.speaker ? { speaker: turn.speaker } : {}) };
      });
      return {
        text: clean.map(turn => turn.text).join(""),
        durationMs: options.durationMs, segments, engine: options.model,
        modelTimed: false, diarized: true,
      };
    }
  }
  const response = await options.client.chat({
    system: SEGMENT_SYSTEM,
    messages: [{ role: "user", content: [
      { type: "text", text: "逐字转写音频中的语音。" },
      { type: "input_audio", input_audio: { data, format: options.format } },
    ] }],
    timeoutMs: 180_000,
    signal: options.signal,
  });
  const text = response.text.replace(/^["“]|["”]$/g, "").trim();
  return { text, durationMs: options.durationMs, segments: segmentTranscript(text, options.durationMs), engine: options.model, modelTimed: false, diarized: false };
}
