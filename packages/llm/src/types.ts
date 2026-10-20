export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  /** Ask the provider for a JSON object response (best effort, provider-dependent). */
  json?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
}

export interface LlmProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /**
   * Streaming variant. Providers that cannot stream may yield the whole
   * reply as a single chunk; callers must not assume chunk granularity.
   */
  chatStream?(request: ChatRequest): AsyncGenerator<string>;
}
