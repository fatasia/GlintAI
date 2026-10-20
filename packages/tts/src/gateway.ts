import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { estimateWordTimings } from "@glintai/scenescript";
import { parseWavDurationMs } from "./wav";
import { parseMp3DurationMs } from "./mp3";
import type { TtsProvider, TtsRequest, TtsResult } from "./index";
export interface GatewayTtsConfig { baseUrl: string; apiKey: string; model: string; voice?: string; params?: Record<string, unknown>; publicDns?: boolean }
/** Async media protocol is intentionally separate from OpenAI /audio/speech. */
export class GatewayTtsProvider implements TtsProvider {
  readonly name = "media-gateway-tts";
  readonly cacheKey: string;
  constructor(private readonly config: GatewayTtsConfig) { this.cacheKey = JSON.stringify([this.name, 1, config.baseUrl, config.model, config.voice, config.params]); }
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (request.speakingRate !== undefined && request.speakingRate !== 1) throw new Error("This gateway voice uses native speed; configure model-specific speed parameters on the server");
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 300000)]) : AbortSignal.timeout(request.timeoutMs ?? 300000);
    const client = new MediaGatewayClient(this.config), voice = request.voice ?? this.config.voice;
    const taskId = await client.submit(this.config.model, request.text, { ...this.config.params, ...(voice ? { voice_id: voice } : {}) }, signal);
    const task = await client.wait(taskId, { signal });
    const { bytes } = await downloadMediaResult(task, signal, { publicDns: this.config.publicDns }), audio = new Uint8Array(bytes);
    const wavDuration = parseWavDurationMs(audio, 0), durationMs = wavDuration || parseMp3DurationMs(audio, 0);
    if (!durationMs) throw new Error(`Unrecognized gateway audio from task ${taskId}`);
    return { audio, durationMs, mimeType: wavDuration ? "audio/wav" : "audio/mpeg", words: estimateWordTimings(request.text, durationMs) };
  }
}
