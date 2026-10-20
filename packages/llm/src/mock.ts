import type { ChatRequest, ChatResponse, LlmProvider } from "./types";

/** Deterministic provider for tests and offline demos. */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";

  constructor(
    private readonly handler: (request: ChatRequest) => string | Promise<string>,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return { text: await this.handler(request) };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    yield await this.handler(request);
  }
}

export function mockLlm(reply: string): MockLlmProvider {
  return new MockLlmProvider(() => reply);
}
