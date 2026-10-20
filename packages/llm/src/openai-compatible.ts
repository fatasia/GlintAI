import type { ChatRequest, ChatResponse, LlmProvider } from "./types";
import { requestLifetime } from "./request";
import { readSseData } from "./sse";

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export function parseReasoningEffort(value: string | undefined): "low" | "high" | "max" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "low" || value === "high" || value === "max") return value;
  throw new Error("LLM reasoning effort must be low, high or max");
}

export interface OpenAICompatibleConfig {
  /** API root, without `/chat/completions`. Gateway compatibility must be verified. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Optional provider-supported reasoning budget; omit for older gateways. */
  reasoningEffort?: "low" | "high" | "max";
}

export class LlmHttpError extends Error {
  constructor(readonly status: number, readonly endpoint: string, readonly bodySnippet: string) {
    super(`LLM request failed: HTTP ${status} from ${endpoint}\nResponse: ${bodySnippet}\nCheck your LLM baseUrl / apiKey / model settings.`);
    this.name = "LlmHttpError";
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly endpoint: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    parseReasoningEffort(config.reasoningEffort);
    this.endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.name = `openai-compatible:${config.model}`;
  }

  private body(request: ChatRequest) {
    return {
      model: this.config.model,
      messages: [
        ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
        ...request.messages,
      ],
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
    };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(body), signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`LLM request to ${this.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) throw new LlmHttpError(response.status, this.endpoint, (await response.text()).slice(0, 300));
    return response;
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const lifetime = requestLifetime(request.signal, request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, `LLM request (${this.endpoint})`);
    try {
      const response = await this.post({ ...this.body(request), stream: true }, lifetime.signal);
      if (!response.body) throw new Error(`LLM stream returned an empty body from ${this.endpoint}.`);
      for await (const payload of readSseData(response.body, lifetime.signal)) {
        if (!payload.trim()) continue;
        if (payload.trim() === "[DONE]") return;
        let parsed: { choices?: Array<{ delta?: { content?: string | null } }>; error?: unknown };
        try { parsed = JSON.parse(payload); }
        catch { throw new Error("Invalid JSON in LLM SSE event"); }
        if (!parsed || parsed.error) throw new Error("LLM stream returned an error event");
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      }
      throw new Error("LLM stream ended before [DONE]. Retry the request or check gateway streaming support.");
    } catch (error) {
      lifetime.error(error);
    } finally {
      lifetime.dispose();
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lifetime = requestLifetime(request.signal, request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, `LLM request (${this.endpoint})`);
    try {
      const response = await this.post({ ...this.body(request), ...(request.json ? { response_format: { type: "json_object" } } : {}) }, lifetime.signal);
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      lifetime.signal.throwIfAborted();
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error(`LLM returned an empty completion from ${this.endpoint}. Check the model name and your account quota.`);
      return { text };
    } catch (error) {
      return lifetime.error(error);
    } finally {
      lifetime.dispose();
    }
  }
}
