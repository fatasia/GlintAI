export interface MiniMaxMusicConfig { apiKey: string; baseUrl?: string; model?: string }
/** Instrumental background music via the official MiniMax API; no session-cookie automation. */
export async function generateMiniMaxMusic(prompt: string, config: MiniMaxMusicConfig, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  if (!prompt.trim() || prompt.length > 2000) throw new Error("Music prompt must be 1..2000 characters");
  options.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 300000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const response = await fetch(`${(config.baseUrl ?? "https://api.minimax.io/v1").replace(/\/+$/, "")}/music_generation`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.model ?? "music-3.0", prompt, is_instrumental: true, stream: false, output_format: "hex", audio_setting: { sample_rate: 44100, bitrate: 128000, format: "mp3" } }), signal, redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MiniMax music returned HTTP ${response.status}`); }
  if (!response.body) throw new Error("Empty music response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 64 * 1024 * 1024) { await reader.cancel(); throw new Error("Music response exceeds 64 MiB"); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (data.base_resp?.status_code !== 0 || data.data?.status !== 2 || typeof data.data?.audio !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(data.data.audio)) throw new Error("MiniMax music failed or returned invalid audio");
  const audio = new Uint8Array(Buffer.from(data.data.audio, "hex"));
  if (audio.length < 24 || !(data.extra_info?.music_duration > 0)) throw new Error("Invalid MiniMax music duration");
  return { audio, mimeType: "audio/mpeg" as const, durationMs: data.extra_info.music_duration as number };
}
