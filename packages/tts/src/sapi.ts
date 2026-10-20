import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  estimateNarrationDurationMs,
  estimateWordTimings,
} from "@glintai/scenescript";
import { parseWavDurationMs } from "./wav";
import type { TtsRequest, TtsResult } from "./index";

const execFileAsync = promisify(execFile);

export interface SapiTtsConfig {
  voice?: string;
  /** SAPI rate -10..10; derived from speakingRate when omitted. */
  rate?: number;
  timeoutMs?: number;
}

/**
 * Offline Windows fallback via SpeechAPI (SAPI 5). No network, no key —
 * quality below neural voices but always available on Windows.
 */
export class SapiTtsProvider {
  readonly name = "windows-sapi";
  get cacheKey() { return JSON.stringify([this.name, this.config.voice, this.config.rate]); }

  constructor(private readonly config: SapiTtsConfig = {}) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    request.signal?.throwIfAborted();
    if (process.platform !== "win32") {
      throw new Error(
        "The windows-sapi provider only works on Windows. Use --tts=edge (network) or --tts=mock (silent).",
      );
    }
    if (!request.text.trim()) {
      throw new Error("Narration text is empty; nothing to synthesize.");
    }
    const rate =
      this.config.rate ??
      Math.max(-3, Math.min(3, Math.round(((request.speakingRate ?? 1) - 1) * 4)));
    const wavPath = path.join(
      os.tmpdir(),
      `glint-sapi-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );
    const spoken = request.text.replace(/\r?\n/g, " ").replace(/'/g, "''");
    const voice = request.voice ?? this.config.voice;
    const voiceLine = voice
      ? `$s.SelectVoice('${voice.replace(/'/g, "''")}')`
      : "";
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Speech",
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
      `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)`,
      "$s.SetOutputToWaveFile('" + wavPath.replace(/'/g, "''") + "', $fmt)",
      `$s.Rate = ${rate}`,
      voiceLine,
      `$s.Speak('${spoken}')`,
      "$s.Dispose()",
    ]
      .filter(Boolean)
      .join("; ");

    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { timeout: request.timeoutMs ?? this.config.timeoutMs ?? 120_000, signal: request.signal, windowsHide: true },
      );
      const audio = new Uint8Array(fs.readFileSync(wavPath));
      const durationMs = parseWavDurationMs(
        audio,
        estimateNarrationDurationMs(request.text, { speakingRate: request.speakingRate }),
      );
      return {
        audio,
        mimeType: "audio/wav",
        durationMs,
        words: estimateWordTimings(request.text, durationMs),
      };
    } finally {
      fs.rmSync(wavPath, { force: true });
    }
  }
}
