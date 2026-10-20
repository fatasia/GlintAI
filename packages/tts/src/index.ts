import {
  estimateNarrationDurationMs,
  estimateWordTimings,
  type WordTiming,
} from "@glintai/scenescript";
import { createSilentWav, parseWavDurationMs } from "./wav";

export { createSilentWav, parseWavDurationMs, WAV_SAMPLE_RATE } from "./wav";
export { parseMp3DurationMs, detectEdgeVoice, EdgeTtsProvider, type EdgeTtsConfig } from "./edge";
export { SapiTtsProvider, type SapiTtsConfig } from "./sapi";
export { synthesizeBatch } from "./batch";
export { QwenLocalTtsProvider, type QwenLocalTtsConfig } from "./qwen";

export const DEFAULT_TTS_TIMEOUT_MS = 120_000;

export interface TtsRequest {
  text: string;
  voice?: string;
  speakingRate?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TtsResult {
  audio: Uint8Array;
  mimeType: "audio/wav" | "audio/mpeg";
  durationMs: number;
  /** Word-level timings aligned to `durationMs`; drives karaoke captions. */
  words: WordTiming[];
  diagnostics?: { inferenceMs: number; peakAllocatedMiB: number; peakReservedMiB: number; speakerEmbeddingCosine?: number };
}

export interface TtsProvider {
  readonly name: string;
  readonly cacheKey?: string;
  dispose?(): void | Promise<void>;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsError";
  }
}

/**
 * Offline provider: estimates duration from text weight and emits a silent
 * WAV with proportional word timings. Keeps rehearsal timings consistent
 * between preview (no audio) and render (silent audio).
 */
export class MockTtsProvider implements TtsProvider {
  readonly name = "mock";

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    request.signal?.throwIfAborted();
    if (!request.text.trim()) {
      throw new TtsError("Narration text is empty; nothing to synthesize.");
    }
    const durationMs = estimateNarrationDurationMs(request.text, {
      speakingRate: request.speakingRate,
    });
    return {
      audio: createSilentWav(durationMs),
      mimeType: "audio/wav",
      durationMs,
      words: estimateWordTimings(request.text, durationMs),
    };
  }
}

export interface OpenAICompatibleTtsConfig {
  /** API root, without `/audio/speech`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
  timeoutMs?: number;
}

export class TtsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly bodySnippet: string,
  ) {
    super(
      `TTS request failed: HTTP ${status} from ${endpoint}\nResponse: ${bodySnippet}\nCheck your TTS baseUrl / apiKey / model settings.`,
    );
    this.name = "TtsHttpError";
  }
}

/**
 * Speaks through any OpenAI-compatible `/audio/speech` endpoint. Remote
 * voices do not expose word timings yet, so timings are estimated against
 * the actual audio duration.
 */
export class OpenAICompatibleTtsProvider implements TtsProvider {
  readonly name: string;
  readonly cacheKey: string;
  private readonly endpoint: string;

  constructor(private readonly config: OpenAICompatibleTtsConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    this.name = `openai-compatible-tts:${config.model}`;
    this.cacheKey = JSON.stringify([this.name, this.endpoint, config.voice ?? "alloy"]);
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!request.text.trim()) {
      throw new TtsError("Narration text is empty; nothing to synthesize.");
    }
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    let response: globalThis.Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: request.text,
          voice: request.voice ?? this.config.voice ?? "alloy",
          response_format: "wav",
          ...(request.speakingRate !== undefined
            ? { speed: request.speakingRate }
            : {}),
        }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `TTS request timed out after ${timeoutMs}ms (${this.endpoint}). Increase timeoutMs or check network/proxy.`,
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`TTS request to ${this.endpoint} failed: ${reason}`, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new TtsHttpError(
        response.status,
        this.endpoint,
        (await response.text()).slice(0, 300),
      );
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    const estimated = estimateNarrationDurationMs(request.text, {
      speakingRate: request.speakingRate,
    });
    const durationMs = parseWavDurationMs(audio, estimated);
    return {
      audio,
      mimeType: "audio/wav",
      durationMs,
      words: estimateWordTimings(request.text, durationMs),
    };
  }
}
