import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildTimeline, placeSfx, type SceneScriptProject } from "@glintai/scenescript";
import { EdgeTtsProvider, SapiTtsProvider, createConfiguredTtsProvider, synthesizeBatch, readCachedTts, type TtsProvider } from "@glintai/tts";
import { generateSynthMusic, generateAmbientMusic, generateSfx } from "@glintai/music";
import { resolveMediaPath, runMediaProcess } from "./native-process";
import { cacheArtifactValid, ffmpegIdentity, fingerprintBytes, recordCacheArtifact } from "./native-cache";

/** Stable key for the audio mix: input files + filter graph + duration + fps. */
export function audioMixKey(inputs: readonly string[], filters: readonly string[], durationMs: number, fps: number): string {
  return createHash("sha256").update(JSON.stringify({
    version: 3,
    // Content, not path: synthesized music/SFX live in a fresh temp workspace each run.
    files: inputs.flatMap((token, index) => token === "-i" ? [inputs[index + 1]!] : []).map(file => fingerprintBytes(fs.readFileSync(file))),
    filters, durationMs, fps,
  })).digest("hex");
}

/** Map scene-relative narration onto the composition without shifting clipped content. */
export function narrationAudioTimingMs(sceneStartMs: number, audioOffsetMs = 0): { startMs: number; sourceOffsetMs: number } | null {
  if (!Number.isFinite(sceneStartMs)) return null;
  const start = sceneStartMs + (Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0);
  if (!Number.isFinite(start)) return null;
  return { startMs: Math.max(0, start), sourceOffsetMs: Math.max(0, -start) };
}

export async function chooseNativeTts(engine: string, onProviderCall?: () => void): Promise<TtsProvider> {
  if (engine === "sapi") return new SapiTtsProvider();
  if (engine === "edge") return new EdgeTtsProvider();
  if (engine !== "auto") return createConfiguredTtsProvider(engine);
  // Offline/CI: never probe the network for a voice; fail with an actionable message instead.
  if (process.env.GLINT_TTS_OFFLINE === "1") {
    if (process.platform === "win32") return new SapiTtsProvider();
    throw new Error("GLINT_TTS_OFFLINE=1 but no local voice is available; pass --tts=mock or configure a local TTS provider");
  }
  const edge = new EdgeTtsProvider();
  try { onProviderCall?.(); await edge.synthesize({ text: "试音", timeoutMs: 15000 }); return edge; }
  catch (error) {
    if (process.platform !== "win32") throw new Error("Default speech is unavailable; configure a TTS provider or explicitly select --tts=mock for a silent test", { cause: error });
    console.warn("[glint] Edge speech unavailable; using local SAPI voice (voice may differ).");
    return new SapiTtsProvider();
  }
}

export function narrationSignature(project: SceneScriptProject): string {
  return fingerprintBytes(JSON.stringify(project.scenes.map(scene => ({ id: scene.id, durationMs: scene.narration.durationMs, segments: scene.narration.segments }))));
}

export function cachedNarrationProject(project: SceneScriptProject, root: string, args: { tts?: string; noCache?: boolean }): { project: SceneScriptProject; exact: boolean } {
  const tts = args.tts ?? "existing";
  if (["existing", "mock"].includes(tts)) return { project, exact: project.scenes.every(scene => scene.narration.durationMs !== undefined) };
  if (args.noCache || tts === "auto" || tts === "qwen") return { project, exact: false };
  let provider: TtsProvider;
  try { provider = createConfiguredTtsProvider(tts); } catch { return { project, exact: false }; }
  const prepared = structuredClone(project);
  const cacheDir = path.join(process.env.GLINT_CACHE_DIR ?? path.join(root, ".cache"), "tts");
  for (const scene of prepared.scenes) {
    const result = readCachedTts(provider, { text: scene.narration.text, voice: scene.narration.voice, speakingRate: scene.narration.speakingRate }, cacheDir);
    if (!result) return { project, exact: false };
    scene.narration.durationMs = result.durationMs;
    scene.narration.segments = [{ text: scene.narration.text, words: result.words }];
  }
  return { project: prepared, exact: true };
}

export async function prepareNativeAudio(project: SceneScriptProject, root: string, workspace: string, args: { beatGrid?: import("@glintai/music").BeatGrid; tts?: string; music?: string; plate?: boolean; noCache?: boolean; ttsCacheOnly?: boolean; onProviderCall?: () => void; signal?: AbortSignal }) {
  const prepared = structuredClone(project);
  const paths = new Map<string, string>();
  let modelCalls = 0;
  const onProviderCall = () => { modelCalls++; args.onProviderCall?.(); };
  const tts = args.tts ?? "existing";
  if (!["existing", "mock"].includes(tts)) {
    const provider = await chooseNativeTts(tts, onProviderCall);
    try {
      const results = await synthesizeBatch(provider, project.scenes.map(scene => ({ text: scene.narration.text, voice: scene.narration.voice, speakingRate: scene.narration.speakingRate })), { concurrency: 1, signal: args.signal, onProviderCall, cacheOnly: args.ttsCacheOnly, cacheDir: args.noCache ? undefined : path.join(process.env.GLINT_CACHE_DIR ?? path.join(root, ".cache"), "tts") });
      for (const [i, result] of results.entries()) {
        const scene = prepared.scenes[i]!;
        const file = path.join(workspace, `${scene.id}.${result.mimeType === "audio/wav" ? "wav" : "mp3"}`);
        fs.writeFileSync(file, result.audio); paths.set(scene.id, file);
        scene.narration.durationMs = result.durationMs;
        scene.narration.segments = [{ text: scene.narration.text, words: result.words }];
      }
    } finally { await provider.dispose?.(); }
  } else if (tts === "existing") {
    for (const scene of prepared.scenes) if (scene.narration.audioRef) paths.set(scene.id, resolveMediaPath(root, scene.narration.audioRef));
  }
  if (tts === "mock") console.warn("[glint] native render: narration is SILENT (--tts=mock); explicit scene durations preserved");
  if (args.beatGrid) (await import("./beat-policy")).injectBeatGrid(prepared, args.beatGrid);
  const timeline = buildTimeline(prepared), fps = prepared.fps ?? 30;
  const inputs: string[] = [], filters: string[] = [], tracks: string[] = [];
  const voiceLabels: string[] = [], musicLabels: string[] = [];
  const add = (file: string, startMs: number, gain: number, loop = false, sourceOffsetMs = 0, role: "voice" | "music" | "sfx" = "sfx") => {
    const index = inputs.filter(item => item === "-i").length;
    if (loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", file);
    const name = `t${index}`;
    const trim = sourceOffsetMs > 0 ? `atrim=start=${sourceOffsetMs / 1000},asetpts=PTS-STARTPTS,` : "";
    filters.push(`[${index}:a]${trim}aresample=44100,adelay=${Math.round(startMs)}:all=1,volume=${gain}[${name}]`);
    tracks.push(`[${name}]`);
    if (role === "voice") voiceLabels.push(`[${name}]`);
    if (role === "music") musicLabels.push(`[${name}]`);
  };
  for (const entry of timeline.entries) {
    const file = paths.get(entry.scene.id);
    const timing = narrationAudioTimingMs(entry.startMs, entry.scene.narration.audioOffsetMs);
    if (file && timing && timing.startMs < timeline.totalMs) {
      add(file, timing.startMs, 1, false, timing.sourceOffsetMs, "voice");
    }
  }
  const music = args.plate ? "off" : args.music ?? (prepared.music ? "existing" : "off");
  if (music === "synth" || music === "auto") {
    const result = music === "synth" ? generateSynthMusic(timeline.totalMs) : await generateAmbientMusic(timeline.totalMs);
    const file = path.join(workspace, "music.wav"); fs.writeFileSync(file, result.audio); add(file, 0, 0.14, true, 0, "music");
  } else if (music === "existing" && prepared.music) add(resolveMediaPath(root, prepared.music.src), 0, prepared.music.volume ?? 0.12, true, 0, "music");
  else if (music !== "off") { if (!fs.statSync(path.resolve(music)).isFile()) throw new Error("Music file not found"); add(path.resolve(music), 0, 0.12, true, 0, "music"); }
  if (!args.plate) {
    const cues = placeSfx(prepared.sfx, timeline.entries.map(e => ({ id: e.scene.id, narration: e.scene.narration, startFrame: Math.round(e.startMs / 1000 * fps) })), fps);
    for (const cue of cues) {
      const file = path.join(workspace, `sfx-${cue.effect}.wav`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, generateSfx(cue.effect as Parameters<typeof generateSfx>[0]).audio);
      add(file, cue.frame / fps * 1000, cue.volume);
    }
  }
  if (!inputs.length) return { project: prepared, audioPath: undefined, modelCalls };
  // AUDIO-08 auto-ducking: with both voice and music present, the music bus is
  // sidechain-compressed by the mixed voice bus (speech wins, music breathes).
  if (voiceLabels.length && musicLabels.length) {
    filters.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:normalize=0,apad=whole_dur=${timeline.totalMs / 1000},asplit=2[voiceout][voicekey]`);
    filters.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:normalize=0[musicbus]`);
    filters.push(`[musicbus][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=120:release=450[musicduck]`);
    const rest = tracks.filter(label => !musicLabels.includes(label) && !voiceLabels.includes(label));
    filters.push(`${["[voiceout]", "[musicduck]", ...rest].join("")}amix=inputs=${2 + rest.length}:normalize=0,alimiter=limit=0.95,apad[out]`);
  } else {
    filters.push(`${tracks.join("")}amix=inputs=${tracks.length}:normalize=0,alimiter=limit=0.95,apad[out]`);
  }
  // Content-addressed mix: same input files + filter graph + duration + fps => same bytes.
  const cacheKey = fingerprintBytes(JSON.stringify({ mix: audioMixKey(inputs, filters, timeline.totalMs, fps), ffmpeg: ffmpegIdentity() ?? randomUUID() }));
  const cacheDirectory = path.resolve(process.env.GLINT_CACHE_DIR ?? ".cache", "native-audio");
  const cached = path.join(cacheDirectory, `${cacheKey}.wav`);
  if (!args.noCache && cacheArtifactValid(cached)) return { project: prepared, audioPath: cached, modelCalls };
  if (!args.noCache) fs.mkdirSync(cacheDirectory, { recursive: true });
  const audioPath = path.join(workspace, "mix.wav");
  await runMediaProcess("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-t", String(timeline.totalMs / 1000), audioPath], { signal: args.signal });
  if (args.noCache) return { project: prepared, audioPath, modelCalls };
  const temporary = `${cached}.${randomUUID()}.tmp`;
  fs.copyFileSync(audioPath, temporary); fs.renameSync(temporary, cached); recordCacheArtifact(cached);
  return { project: prepared, audioPath: cached, modelCalls };
}
