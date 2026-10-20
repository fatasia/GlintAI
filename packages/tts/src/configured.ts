import { EdgeTtsProvider, SapiTtsProvider, MockTtsProvider, QwenLocalTtsProvider, OpenAICompatibleTtsProvider, ElevenLabsTtsProvider, FishTtsProvider, MiniMaxTtsProvider, GatewayTtsProvider, type TtsProvider } from "./index";
type Env = Record<string, string | undefined>;
export function configuredVoiceEngines(env: Env = process.env, platform = process.platform) {
  return ["mock", "edge", ...(platform === "win32" ? ["sapi"] : []), ...(env.GLINT_QWEN_MODEL && env.GLINT_QWEN_REFERENCE ? ["qwen"] : []), ...(env.GLINT_TTS_API_KEY && env.GLINT_TTS_MODEL && env.GLINT_TTS_BASE_URL ? ["openai"] : []), ...(env.GLINT_ELEVENLABS_API_KEY && env.GLINT_ELEVENLABS_VOICE ? ["elevenlabs"] : []), ...(env.GLINT_FISH_API_KEY && env.GLINT_FISH_VOICE ? ["fish"] : []), ...(env.GLINT_MINIMAX_API_KEY && env.GLINT_MINIMAX_VOICE ? ["minimax"] : []), ...(env.GLINT_MEDIA_API_KEY && env.GLINT_MEDIA_BASE_URL && env.GLINT_MEDIA_TTS_MODEL ? ["gateway"] : [])];
}
/** Credentials and reference paths stay on the server. No silent fallback. */
export function createConfiguredTtsProvider(engine: string, env: Env = process.env): TtsProvider {
  if (!configuredVoiceEngines(env).includes(engine)) throw new Error(`TTS engine ${engine} is unavailable; configure it on the server`);
  switch (engine) {
    case "edge": return new EdgeTtsProvider();
    case "sapi": return new SapiTtsProvider();
    case "mock": return new MockTtsProvider();
    case "qwen": return new QwenLocalTtsProvider({ python: env.GLINT_QWEN_PYTHON ?? "python", modelDir: env.GLINT_QWEN_MODEL!, referenceAudio: env.GLINT_QWEN_REFERENCE!, referenceText: env.GLINT_QWEN_REFERENCE_TEXT });
    case "openai": return new OpenAICompatibleTtsProvider({ baseUrl: env.GLINT_TTS_BASE_URL!, apiKey: env.GLINT_TTS_API_KEY!, model: env.GLINT_TTS_MODEL!, voice: env.GLINT_TTS_VOICE });
    case "elevenlabs": return new ElevenLabsTtsProvider({ apiKey: env.GLINT_ELEVENLABS_API_KEY!, voiceId: env.GLINT_ELEVENLABS_VOICE!, model: env.GLINT_ELEVENLABS_MODEL });
    case "fish": return new FishTtsProvider({ apiKey: env.GLINT_FISH_API_KEY!, referenceId: env.GLINT_FISH_VOICE!, model: env.GLINT_FISH_MODEL });
    case "minimax": return new MiniMaxTtsProvider({ apiKey: env.GLINT_MINIMAX_API_KEY!, voiceId: env.GLINT_MINIMAX_VOICE!, model: env.GLINT_MINIMAX_TTS_MODEL, baseUrl: env.GLINT_MINIMAX_BASE_URL });
    case "gateway": return new GatewayTtsProvider({ apiKey: env.GLINT_MEDIA_API_KEY!, baseUrl: env.GLINT_MEDIA_BASE_URL!, model: env.GLINT_MEDIA_TTS_MODEL!, voice: env.GLINT_MEDIA_TTS_VOICE, params: env.GLINT_MEDIA_TTS_PARAMS ? JSON.parse(env.GLINT_MEDIA_TTS_PARAMS) : undefined, publicDns: env.GLINT_MEDIA_PUBLIC_DNS === "1" });
    default: throw new Error("Unknown TTS engine");
  }
}
