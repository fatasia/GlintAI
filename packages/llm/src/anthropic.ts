import type { ChatRequest, ChatResponse, LlmProvider } from "./types";
import { requestLifetime } from "./request";

export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicConfig {
  /** Defaults to https://api.anthropic.com; also works for compatible gateways. */
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class AnthropicHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly bodySnippet: string,
  ) {
    super(
      `Anthropic request failed: HTTP ${status} from ${endpoint}\nResponse: ${bodySnippet}\nCheck your apiKey / model settings.`,
    );
    this.name = "AnthropicHttpError";
  }
}

/** Single, non-streaming Anthropic Messages API call; no chatStream implementation. */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private readonly endpoint: string;

  constructor(private readonly config: AnthropicConfig) {
    this.endpoint = `${(config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
    this.name = `anthropic:${config.model}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS;
    const lifetime = requestLifetime(request.signal, timeoutMs, `Anthropic request (${this.endpoint})`);
    const { signal } = lifetime;
    try {
      let response: globalThis.Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: this.config.maxTokens ?? 4096,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages,
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Anthropic request to ${this.endpoint} failed: ${reason}`, {
          cause: error,
        });
      }

      if (!response.ok) {
        throw new AnthropicHttpError(
          response.status,
          this.endpoint,
          (await response.text()).slice(0, 300),
        );
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (data.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      if (!text) {
        throw new Error(`Anthropic returned an empty completion from ${this.endpoint}.`);
      }
      signal.throwIfAborted();
      return { text };
    } catch (error) {
      return lifetime.error(error);
    } finally {
      lifetime.dispose();
    }
  }
}
