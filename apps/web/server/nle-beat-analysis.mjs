import fs from "node:fs";
import { createHash } from "node:crypto";
import { detectBeats } from "@glintai/music";
import { estimateBeatGrids } from "./nle-beat-calibration.mjs";

/** Analyze only a bounded section of a library audio asset, never a client path or URL. */
export async function analyzeNleAudioBeats({ name, startMs, durationMs, media, signal }) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:mp3|wav)$/.test(name) || !Number.isFinite(startMs) || startMs < 0 || startMs > 21_600_000 || !Number.isFinite(durationMs) || durationMs < 500 || durationMs > 120_000) throw Object.assign(new Error("请选择素材库中时长 0.5–120 秒的音频片段。"), { status: 400 });
  const source = media.asset(name);
  if (!source) throw Object.assign(new Error("音频素材不存在。"), { status: 404 });
  const limited = AbortSignal.any([signal, AbortSignal.timeout(70_000)]);
  const digest = async () => {
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024 || media.asset(name) !== source) throw new Error("音频文件无效或超过 64 MiB。");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(source, { signal: limited })) hash.update(chunk);
    return hash.digest("hex");
  };
  const sha256 = await digest();
  const result = await detectBeats(source, { signal: limited, timeoutMs: 60_000, startMs, durationMs, maxOutputBytes: Math.ceil(durationMs * 44.1) + 44_100, localOnly: true });
  if (await digest() !== sha256) throw new Error("音频在分析期间发生变化，请重新分析。");
  const beatsMs = result.beatsMs.filter(ms => ms >= 0 && ms < durationMs);
  return { bpm: result.bpm, beatsMs, sourceSha256: sha256, scope: "estimated-energy-peaks", calibration: estimateBeatGrids(beatsMs, durationMs) };
}
