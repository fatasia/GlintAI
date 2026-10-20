import { normalizeLlmBase, discoverLlmModels, llmFromEnvironment } from "@glintai/llm";
export function createLlmSettings(env = process.env) {
  function connection(body) {
    const baseUrl = normalizeLlmBase(body.baseUrl ?? env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4");
    const existingBase = env.GLINT_LLM_BASE_URL && normalizeLlmBase(env.GLINT_LLM_BASE_URL);
    const apiKey = body.apiKey || (existingBase === baseUrl ? env.GLINT_LLM_API_KEY : undefined);
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 1000) throw new Error("Enter a key for this service address");
    const protocol = body.protocol ?? "auto";
    if (!["auto", "openai", "responses", "anthropic", "gemini"].includes(protocol)) throw new Error("Unknown protocol");
    return { baseUrl, apiKey, protocol, model: typeof body.model === "string" ? body.model.trim() : "" };
  }
  return {
    read: () => ({ baseUrl: env.GLINT_LLM_BASE_URL ?? "", model: env.GLINT_LLM_MODEL ?? "", protocol: env.GLINT_LLM_PROTOCOL ?? "auto", configured: Boolean(env.GLINT_LLM_API_KEY), storage: "process-memory" }),
    async models(body, signal) { const config = connection(body); return discoverLlmModels(config.baseUrl, config.apiKey, signal); },
    save(body) {
      const config = connection(body);
      if (!config.model || config.model.length > 160) throw new Error("Choose or enter a model");
      env.GLINT_LLM_BASE_URL = config.baseUrl; env.GLINT_LLM_API_KEY = config.apiKey; env.GLINT_LLM_MODEL = config.model; env.GLINT_LLM_PROTOCOL = config.protocol;
      return { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, configured: true, storage: "process-memory" };
    },
    async test(signal) {
      const provider = llmFromEnvironment(env), started = performance.now();
      const response = await provider.chat({ messages: [{ role: "user", content: "Reply with exactly GLINT_OK and nothing else." }], timeoutMs: 30000, signal });
      if (!response.text.includes("GLINT_OK")) throw new Error("The model did not return the test marker");
      return { passed: true, protocol: provider.resolvedProtocol ?? env.GLINT_LLM_PROTOCOL, elapsedMs: Math.round(performance.now() - started), model: env.GLINT_LLM_MODEL };
    },
  };
}
