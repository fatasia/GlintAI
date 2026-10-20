import type { ChatRequest, ChatResponse, LlmProvider } from "./types";
import { OpenAICompatibleProvider, LlmHttpError, parseReasoningEffort } from "./openai-compatible";
import { AnthropicProvider, AnthropicHttpError } from "./anthropic";
import { requestLifetime } from "./request";
export type LlmProtocol = "auto" | "openai" | "responses" | "anthropic" | "gemini";
export interface LlmConnection { baseUrl: string; apiKey: string; model: string; protocol?: LlmProtocol; reasoningEffort?: "low" | "high" | "max" }
export function normalizeLlmBase(value: string) {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS, or an explicit loopback HTTP model server; no credentials/query in URL");
  return url.href.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages|models)$/, "");
}
function openaiBase(base: string) { const url = new URL(base); return url.pathname === "/" ? `${base}/v1` : base; }
class ProtocolHttpError extends Error { constructor(readonly status: number) { super(`LLM protocol returned HTTP ${status}`); } }
class JsonProtocolProvider implements LlmProvider {
  readonly name: string;
  constructor(private config: LlmConnection, private protocol: "responses" | "gemini") { this.name = `${protocol}:${config.model}`; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lifetime = requestLifetime(request.signal, request.timeoutMs ?? 60000, this.name);
    const root = normalizeLlmBase(this.config.baseUrl);
    const endpoint = this.protocol === "responses" ? `${openaiBase(root)}/responses` : `${root.replace(/\/(?:v1|v1beta)$/, "")}/v1beta/models/${encodeURIComponent(this.config.model.replace(/^models\//, ""))}:generateContent`;
    const body = this.protocol === "responses" ? {
      model: this.config.model, input: request.messages, ...(request.system ? { instructions: request.system } : {}), ...(request.json ? { text: { format: { type: "json_object" } } } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    } : {
      contents: request.messages.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}), generationConfig: { ...(request.json ? { responseMimeType: "application/json" } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
    };
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(this.protocol === "gemini" ? { "x-goog-api-key": this.config.apiKey } : { authorization: `Bearer ${this.config.apiKey}` }) }, body: JSON.stringify(body), signal: lifetime.signal, redirect: "error" });
      if (!response.ok) { await response.body?.cancel(); throw new ProtocolHttpError(response.status); }
      const data = await boundedJson(response); lifetime.signal.throwIfAborted();
      const text = this.protocol === "responses" ? data.output?.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("") : data.candidates?.[0]?.content?.parts?.filter((part: any) => !part.thought).map((part: any) => part.text ?? "").join("");
      if (!text) throw new Error("LLM returned no text in the selected protocol");
      return { text };
    } catch (error) { return lifetime.error(error); } finally { lifetime.dispose(); }
  }
}
function specific(config: LlmConnection, protocol: Exclude<LlmProtocol, "auto">): LlmProvider {
  const base = normalizeLlmBase(config.baseUrl);
  if (protocol === "openai") return new OpenAICompatibleProvider({ ...config, baseUrl: openaiBase(base) });
  if (protocol === "anthropic") return new AnthropicProvider({ ...config, baseUrl: base.replace(/\/v1$/, "") });
  return new JsonProtocolProvider({ ...config, baseUrl: base }, protocol);
}
export class AutoLlmProvider implements LlmProvider {
  readonly name: string;
  resolvedProtocol?: Exclude<LlmProtocol, "auto">;
  private resolved?: LlmProvider;
  constructor(private config: LlmConnection) { normalizeLlmBase(config.baseUrl); this.name = `auto:${config.model}`; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.resolved) return this.resolved.chat(request);
    const order: Exclude<LlmProtocol, "auto">[] = /gemini|generativelanguage|v1beta/i.test(`${this.config.baseUrl} ${this.config.model}`) ? ["gemini", "openai", "anthropic", "responses"] : /anthropic|claude/i.test(`${this.config.baseUrl} ${this.config.model}`) ? ["anthropic", "openai", "responses", "gemini"] : ["openai", "anthropic", "responses", "gemini"];
    const lifetime = requestLifetime(request.signal, request.timeoutMs ?? 60000, "LLM protocol discovery");
    try {
      for (const protocol of order) {
        lifetime.signal.throwIfAborted(); const provider = specific(this.config, protocol);
        try { const result = await provider.chat({ ...request, signal: lifetime.signal }); this.resolved = provider; this.resolvedProtocol = protocol; return result; }
        catch (error) {
          const status = error instanceof LlmHttpError || error instanceof AnthropicHttpError || error instanceof ProtocolHttpError ? error.status : 0;
          const explicitMismatch = error instanceof LlmHttpError && status === 400 && /unsupported.{0,30}(protocol|endpoint)|only supports.{0,30}(anthropic|responses|gemini)|不支持.{0,20}(协议|端点)/i.test(error.bodySnippet);
          if (![404, 405].includes(status) && !explicitMismatch) throw error;
        }
      }
      throw new Error("No supported LLM protocol found; choose the documented protocol manually");
    } catch (error) { return lifetime.error(error); } finally { lifetime.dispose(); }
  }
  async *chatStream(request: ChatRequest) {
    if (this.resolved?.chatStream) yield* this.resolved.chatStream(request);
    else yield (await this.chat(request)).text;
  }
}
export function createLlmProvider(config: LlmConnection): LlmProvider {
  if (!["auto", "openai", "responses", "anthropic", "gemini"].includes(config.protocol ?? "auto")) throw new Error("Unknown LLM protocol");
  return !config.protocol || config.protocol === "auto" ? new AutoLlmProvider(config) : specific(config, config.protocol);
}
export function llmFromEnvironment(env: Record<string, string | undefined> = process.env) {
  if (!env.GLINT_LLM_API_KEY) throw new Error("Configure an LLM API key on the server");
  return createLlmProvider({ baseUrl: env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", apiKey: env.GLINT_LLM_API_KEY, model: env.GLINT_LLM_MODEL ?? "glm-4", protocol: (env.GLINT_LLM_PROTOCOL ?? "auto") as LlmProtocol, reasoningEffort: parseReasoningEffort(env.GLINT_LLM_REASONING_EFFORT) });
}
async function boundedJson(response: Response) {
  if (!response.body) throw new Error("Empty provider response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Provider response exceeds 4 MiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function discoverLlmModels(baseUrl: string, apiKey: string, signal = AbortSignal.timeout(20000)) {
  const base = normalizeLlmBase(baseUrl), root = new URL(base);
  const candidates = [...new Set([`${openaiBase(base)}/models`, `${root.origin}/v1beta/models`])];
  for (const endpoint of candidates) {
    const models: { id: string; protocols: unknown[] }[] = [], seen = new Set<string>();
    let next: string | undefined = endpoint;
    for (let page = 0; next && page < 20; page++) {
      const response = await fetch(next, { headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "x-goog-api-key": apiKey, ...(root.hostname === "api.anthropic.com" ? { "anthropic-version": "2023-06-01" } : {}) }, signal, redirect: "error" });
      if ([404, 405].includes(response.status) && page === 0) { await response.body?.cancel(); break; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery returned HTTP ${response.status}`); }
      const body = await boundedJson(response), list = body.data ?? body.models;
      if (!Array.isArray(list)) throw new Error("Provider did not return a model catalog; enter the model name manually");
      for (const item of list) {
        const id = String(item.id ?? item.name ?? "").replace(/^models\//, "");
        if (id && !seen.has(id)) { seen.add(id); models.push({ id, protocols: item.supported_endpoint_types ?? item.supportedGenerationMethods ?? [] }); }
      }
      const token = body.nextPageToken ?? (body.has_more ? body.last_id : undefined);
      if (token) { const url = new URL(endpoint); url.searchParams.set(body.nextPageToken ? "pageToken" : "after_id", String(token)); next = url.href; }
      else next = undefined;
      if (models.length >= 1000 || !next) return { baseUrl: base, models: models.slice(0, 1000), truncated: Boolean(next) || models.length > 1000 };
    }
    if (models.length) return { baseUrl: base, models: models.slice(0, 1000), truncated: Boolean(next) };
  }
  throw new Error("This service does not expose a model list; enter its model name manually");
}
