import fs from "node:fs";
import path from "node:path";
import { normalizeLlmBase, discoverLlmModels, llmFromEnvironment } from "@glintai/llm";

const FILE_LIMIT = 8 * 1024;
const PROTOCOLS = ["auto", "openai", "responses", "anthropic", "gemini"];

/**
 * Text-model settings. Values are persisted next to the media gateway settings
 * (mode 0600) so a restart does not lose the connection; the key is never
 * returned by the read path.
 */
export function createLlmSettings(env = process.env, file) {
  let saved = null;
  if (file && fs.existsSync(file) && fs.statSync(file).size <= FILE_LIMIT) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const baseUrl = typeof parsed?.baseUrl === "string" ? normalizeLlmBase(parsed.baseUrl) : "";
      const apiKey = typeof parsed?.apiKey === "string" ? parsed.apiKey : "";
      const model = typeof parsed?.model === "string" ? parsed.model.trim() : "";
      const protocol = PROTOCOLS.includes(parsed?.protocol) ? parsed.protocol : "auto";
      if (baseUrl && apiKey && model) saved = { baseUrl, apiKey, model, protocol };
    } catch { saved = null; }
  }
  const effective = () => ({
    baseUrl: saved?.baseUrl ?? normalizeLlmBase(env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4"),
    apiKey: saved?.apiKey ?? (typeof env.GLINT_LLM_API_KEY === "string" ? env.GLINT_LLM_API_KEY : ""),
    model: saved?.model ?? (typeof env.GLINT_LLM_MODEL === "string" ? env.GLINT_LLM_MODEL : ""),
    protocol: saved?.protocol ?? (PROTOCOLS.includes(env.GLINT_LLM_PROTOCOL) ? env.GLINT_LLM_PROTOCOL : "auto"),
  });
  if (saved) {
    env.GLINT_LLM_BASE_URL = saved.baseUrl;
    env.GLINT_LLM_API_KEY = saved.apiKey;
    env.GLINT_LLM_MODEL = saved.model;
    env.GLINT_LLM_PROTOCOL = saved.protocol;
  }
  function connection(body = {}) {
    const current = effective();
    const baseUrl = normalizeLlmBase(body.baseUrl ?? current.baseUrl);
    const apiKey = body.apiKey || (normalizeLlmBase(current.baseUrl) === baseUrl ? current.apiKey : undefined);
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 1000) throw new Error("Enter a key for this service address");
    const protocol = body.protocol ?? "auto";
    if (!PROTOCOLS.includes(protocol)) throw new Error("Unknown protocol");
    return { baseUrl, apiKey, protocol, model: typeof body.model === "string" ? body.model.trim() : "" };
  }
  return {
    read() {
      const { baseUrl, model, protocol, apiKey } = effective();
      return { baseUrl, model, protocol, configured: Boolean(apiKey), keyHint: apiKey ? (apiKey.length > 8 ? `…${apiKey.slice(-4)}` : "已配置") : "", storage: saved ? "saved" : apiKey ? "environment" : "none" };
    },
    async models(body, signal) { const config = connection(body); return discoverLlmModels(config.baseUrl, config.apiKey, signal); },
    save(body) {
      const config = connection(body);
      if (!config.model || config.model.length > 160) throw new Error("Choose or enter a model");
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
        fs.renameSync(temporary, file);
        saved = { ...config };
      }
      env.GLINT_LLM_BASE_URL = config.baseUrl; env.GLINT_LLM_API_KEY = config.apiKey; env.GLINT_LLM_MODEL = config.model; env.GLINT_LLM_PROTOCOL = config.protocol;
      return { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, configured: true, storage: file ? "saved" : "process-memory" };
    },
    async test(signal) {
      const provider = llmFromEnvironment(env), started = performance.now();
      const response = await provider.chat({ messages: [{ role: "user", content: "Reply with exactly GLINT_OK and nothing else." }], timeoutMs: 30000, signal });
      if (!response.text.includes("GLINT_OK")) throw new Error("The model did not return the test marker");
      return { passed: true, protocol: provider.resolvedProtocol ?? env.GLINT_LLM_PROTOCOL, elapsedMs: Math.round(performance.now() - started), model: env.GLINT_LLM_MODEL };
    },
  };
}
