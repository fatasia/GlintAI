import { estimateWordTimings, type WordTiming } from "@glintai/scenescript";
import { parseMp3DurationMs } from "./mp3";
import type { TtsRequest, TtsResult } from "./index";
import { estimateNarrationDurationMs } from "@glintai/scenescript";

/** Duration of a CBR mp3 buffer; re-exported for provider tests. */
export { parseMp3DurationMs } from "./mp3";

export function detectEdgeVoice(text: string): string {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
  const total = cjk + latin;
  const isZh = total > 0 && cjk / total >= 0.15;
  return isZh ? "zh-CN-XiaoxiaoNeural" : "en-US-AriaNeural";
}

export interface EdgeTtsConfig {
  /** Neural voice name; auto-matched zh/en from the text when omitted. */
  voice?: string;
  timeoutMs?: number;
}

export const DEFAULT_EDGE_TTS_TIMEOUT_MS = 60_000;

function concat(chunks: Buffer[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Microsoft Edge Read-Aloud neural voices (the `msedge-tts` transport):
 * no API key, high-quality zh/en voices. Duration comes from mp3 frame
 * headers; word timings are estimated against it.
 */
export class EdgeTtsProvider {
  readonly name: string;

  constructor(private readonly config: EdgeTtsConfig = {}) {
    this.name = `edge-tts:${config.voice ?? "auto"}`;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    request.signal?.throwIfAborted();
    if (!request.text.trim()) {
      throw new Error("Narration text is empty; nothing to synthesize.");
    }
    const voice = request.voice ?? this.config.voice ?? detectEdgeVoice(request.text);
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_EDGE_TTS_TIMEOUT_MS;

    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    request.signal?.throwIfAborted();
    const tts = new MsEdgeTTS();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const chunks: Buffer[] = [];
    let removeAbort = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => { reject(signal.reason); tts.close(); };
        signal.addEventListener("abort", stop, { once: true });
        removeAbort = () => signal.removeEventListener("abort", stop);
        if (signal.aborted) stop();
      });
      const synthesize = async () => {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        signal.throwIfAborted();
        const { audioStream } = tts.toStream(request.text, { rate: request.speakingRate ?? 1 });
        let bytes = 0;
        await new Promise<void>((resolve, reject) => {
          audioStream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 32 * 1024 * 1024) { reject(new Error("TTS audio exceeds 32 MiB")); audioStream.destroy(); }
            else chunks.push(chunk);
          });
          audioStream.on("end", resolve);
          audioStream.on("error", reject);
        });
      };
      await Promise.race([synthesize(), aborted]);
      signal.throwIfAborted();
    } finally {
      removeAbort();
      tts.close();
    }

    const audio = concat(chunks);
    const durationMs = parseMp3DurationMs(
      audio,
      estimateNarrationDurationMs(request.text, { speakingRate: request.speakingRate }),
    );
    return {
      audio,
      mimeType: "audio/mpeg",
      durationMs,
      words: estimateWordTimings(request.text, durationMs),
    };
  }
}

export type { WordTiming };
