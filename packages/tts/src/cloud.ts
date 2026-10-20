import { estimateWordTimings } from "@glintai/scenescript";
import type { TtsProvider, TtsRequest, TtsResult } from "./index";
import { parseWavDurationMs } from "./wav";
import { parseMp3DurationMs } from "./mp3";

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty TTS response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("TTS response exceeds size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function post(url: string, headers: Record<string, string>, body: unknown, request: TtsRequest, limit: number) {
  request.signal?.throwIfAborted();
  if (!request.text.trim() || request.text.length > 10000) throw new Error("Cloud narration must be 1..10000 characters");
  if (request.speakingRate !== undefined && (!Number.isFinite(request.speakingRate) || request.speakingRate < 0.7 || request.speakingRate > 1.2)) throw new Error("This voice engine supports speed 0.7..1.2");
  const deadline = AbortSignal.timeout(request.timeoutMs ?? 120000);
  const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`TTS provider returned HTTP ${response.status}`); }
  return boundedBody(response, limit);
}
export interface ElevenLabsTtsConfig {
  apiKey: string; voiceId: string; model?: string; baseUrl?: string;
  voiceSettings?: { stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean };
}
/** Uses provider character alignment instead of estimated subtitle pacing. */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  readonly cacheKey: string;
  constructor(private readonly config: ElevenLabsTtsConfig) {
    this.cacheKey = JSON.stringify([this.name, 1, config.baseUrl ?? "https://api.elevenlabs.io/v1", config.model ?? "eleven_multilingual_v2", config.voiceId, config.voiceSettings]);
  }
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const voice = request.voice ?? this.config.voiceId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(voice)) throw new Error("Invalid ElevenLabs voice ID");
    const url = `${(this.config.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/\/+$/, "")}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`;
    const bytes = await post(url, { "xi-api-key": this.config.apiKey }, { text: request.text, model_id: this.config.model ?? "eleven_multilingual_v2", voice_settings: { ...this.config.voiceSettings, ...(request.speakingRate !== undefined ? { speed: request.speakingRate } : {}) } }, request, 48 * 1024 * 1024);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof data.audio_base64 !== "string" || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data.audio_base64)) throw new Error("Invalid ElevenLabs audio");
    const audio = new Uint8Array(Buffer.from(data.audio_base64, "base64"));
    const alignment = data.normalized_alignment ?? data.alignment;
    if (!audio.length || !Array.isArray(alignment?.characters) || !alignment.characters.length || alignment.characters.length !== alignment.character_start_times_seconds?.length || alignment.characters.length !== alignment.character_end_times_seconds?.length) throw new Error("Missing ElevenLabs alignment");
    const words = alignment.characters.flatMap((text: unknown, index: number) => {
      const start = alignment.character_start_times_seconds[index], end = alignment.character_end_times_seconds[index];
      if (typeof text !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw new Error("Invalid ElevenLabs alignment");
      return text.trim() ? [{ text, startMs: Math.round(start * 1000), endMs: Math.max(1, Math.round(end * 1000)) }] : [];
    });
    const durationMs = parseMp3DurationMs(audio, 0);
    if (!durationMs || !words.length || words.some((word: {endMs:number}) => word.endMs > durationMs + 250)) throw new Error("Invalid ElevenLabs audio duration/alignment");
    return { audio, mimeType: "audio/mpeg", durationMs, words };
  }
}
export interface FishTtsConfig { apiKey: string; referenceId: string; model?: string; baseUrl?: string }
/** Fish hosted voices, native speed/normalization; estimated caption timing. */
export class FishTtsProvider implements TtsProvider {
  readonly name = "fish";
  readonly cacheKey: string;
  constructor(private readonly config: FishTtsConfig) {
    this.cacheKey = JSON.stringify([this.name, 1, config.baseUrl ?? "https://api.fish.audio/v1", config.model ?? "s2.1-pro", config.referenceId]);
  }
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const audio = await post(`${(this.config.baseUrl ?? "https://api.fish.audio/v1").replace(/\/+$/, "")}/tts`, { authorization: `Bearer ${this.config.apiKey}`, model: this.config.model ?? "s2.1-pro" }, { text: request.text, reference_id: request.voice ?? this.config.referenceId, format: "wav", sample_rate: 24000, normalize: true, latency: "normal", prosody: { speed: request.speakingRate ?? 1, normalize_loudness: true } }, request, 32 * 1024 * 1024);
    const durationMs = parseWavDurationMs(audio, 0);
    if (!durationMs) throw new Error("Invalid Fish WAV output");
    return { audio, mimeType: "audio/wav", durationMs, words: estimateWordTimings(request.text, durationMs) };
  }
}
export interface MiniMaxTtsConfig { apiKey: string; voiceId: string; model?: string; baseUrl?: string; emotion?: string; pronunciation?: string[] }
/** MiniMax synchronous API, inline hex audio (no expiring audio URL fetch). */
export class MiniMaxTtsProvider implements TtsProvider {
  readonly name = "minimax";
  readonly cacheKey: string;
  constructor(private readonly config: MiniMaxTtsConfig) {
    this.cacheKey = JSON.stringify([this.name, 1, config.baseUrl ?? "https://api.minimax.io/v1", config.model ?? "speech-2.8-hd", config.voiceId, config.emotion, config.pronunciation]);
  }
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const bytes = await post(`${(this.config.baseUrl ?? "https://api.minimax.io/v1").replace(/\/+$/, "")}/t2a_v2`, { authorization: `Bearer ${this.config.apiKey}` }, { model: this.config.model ?? "speech-2.8-hd", text: request.text, stream: false, output_format: "hex", language_boost: "auto", text_normalization_mode: "quality", voice_setting: { voice_id: request.voice ?? this.config.voiceId, speed: request.speakingRate ?? 1, vol: 1, pitch: 0, ...(this.config.emotion ? { emotion: this.config.emotion } : {}) }, ...(this.config.pronunciation ? { pronunciation_dict: { tone: this.config.pronunciation } } : {}), audio_setting: { sample_rate: 32000, format: "wav", channel: 1 } }, request, 64 * 1024 * 1024);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.base_resp?.status_code !== 0 || data.data?.status !== 2 || typeof data.data?.audio !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(data.data.audio)) throw new Error("MiniMax synthesis failed or returned invalid audio");
    const audio = new Uint8Array(Buffer.from(data.data.audio, "hex")), durationMs = parseWavDurationMs(audio, 0);
    if (!durationMs) throw new Error("Invalid MiniMax WAV output");
    return { audio, durationMs, mimeType: "audio/wav", words: estimateWordTimings(request.text, durationMs) };
  }
}
