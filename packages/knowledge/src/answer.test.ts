import { describe, expect, it } from "vitest";
import { AnswerEngine, GROUNDED_ANSWER_SYSTEM, REFUSAL_SENTINEL, type StreamEvent } from "./answer";
import { MockLlmProvider } from "@glintai/llm";
import { loadMarkdown } from "./markdown";
import { LexicalKnowledgeBase } from "./retrieval";

function makeEngine(handler: (userContent: string) => string) {
  let llmCalls = 0;
  const llm = new MockLlmProvider((req) => {
    llmCalls += 1;
    const user = req.messages.find((m) => m.role === "user");
    return handler(user?.content ?? "");
  });
  const kb = new LexicalKnowledgeBase();
  kb.addDocument(
    loadMarkdown(
      [
        "# 熵",
        "",
        "## 定义",
        "",
        "熵是热力学系统中混乱程度的度量。",
        "",
        "## 生命",
        "",
        "生命以负熵为食,靠消耗能量维持有序。",
      ].join("\n"),
      { docId: "entropy" },
    ),
  );
  return { engine: new AnswerEngine({ kb, llm, topK: 3 }), calls: () => llmCalls };
}

describe("AnswerEngine", () => {
  it.each(["NOT_IN_SOURCE", "prefix NOT_IN_SOURCE", "  not_in_source  ", "看似正常的回答但最后 NOT_IN_SOURCE", "\n\t"])("never exposes refused content: %s", async (reply) => {
    const kb = new LexicalKnowledgeBase();
    kb.addDocument(loadMarkdown("# 熵\n熵是混乱程度。", { docId: "entropy" }));
    const llm = { name: "mock", chat: async () => ({ text: reply }), async *chatStream() { for (const c of reply) yield c; } };
    const engine = new AnswerEngine({ kb, llm });
    const events: StreamEvent[] = [];
    for await (const event of engine.streamAnswer("熵是什么")) events.push(event);
    expect(events.some((event) => event.type === "delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", answer: { refused: true } });
  });
  it("forwards cancellation and timeout without emitting buffered model text", async () => {
    const kb = new LexicalKnowledgeBase();
    kb.addDocument(loadMarkdown("# 熵\n熵是混乱程度。", { docId: "entropy" }));
    const controller = new AbortController();
    const llm = {
      name: "mock", chat: async () => ({ text: "unused" }),
      async *chatStream(request: { signal?: AbortSignal; timeoutMs?: number }) {
        expect(request.signal).toBe(controller.signal);
        expect(request.timeoutMs).toBe(25);
        yield "private partial";
        controller.abort(new Error("cancelled"));
        yield "tail";
      },
    };
    const events: StreamEvent[] = [];
    const stream = new AnswerEngine({ kb, llm }).streamAnswer("熵是什么", { signal: controller.signal, timeoutMs: 25 });
    await expect((async () => { for await (const event of stream) events.push(event); })()).rejects.toThrow("cancelled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "citations" });
  });

  it("non-streaming fallback calls the model only once", async () => {
    const { engine, calls } = makeEngine(() => "熵是混乱程度。");
    const events: StreamEvent[] = [];
    for await (const event of engine.streamAnswer("熵是什么")) events.push(event);
    expect(calls()).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", answer: { refused: false } });
  });

  it("answers from the knowledge source with citations", async () => {
    const { engine } = makeEngine(() => "熵是系统混乱程度的度量。");
    const answer = await engine.answer("熵是什么?");
    expect(answer.refused).toBe(false);
    expect(answer.answer).toBe("熵是系统混乱程度的度量。");
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations[0]!.docId).toBe("entropy");
    expect(answer.citations[0]!.snippet.length).toBeGreaterThan(0);
  });

  it("refuses when the model declares the topic out of source", async () => {
    const { engine } = makeEngine(() => REFUSAL_SENTINEL);
    // Vocabulary overlaps the corpus (系统/混乱 hit the definition chunk),
    // but the actual question — stock prediction — is not in the source.
    const answer = await engine.answer("系统的混乱程度可以预测股价吗?");
    expect(answer.refused).toBe(true);
    expect(answer.refusalReason).toBe("model_declined");
    expect(answer.answer).toBeNull();
    // Citations still describe what was retrieved — auditable refusal.
    expect(answer.citations.length).toBeGreaterThan(0);
  });

  it("treats a blank model reply as a refusal", async () => {
    const { engine } = makeEngine(() => "   ");
    const answer = await engine.answer("熵是什么?");
    expect(answer.refused).toBe(true);
    expect(answer.refusalReason).toBe("model_declined");
  });

  it("refuses empty questions without calling the LLM", async () => {
    const { engine, calls } = makeEngine(() => "unused");
    const answer = await engine.answer("   ");
    expect(answer.refused).toBe(true);
    expect(answer.refusalReason).toBe("no_relevant_context");
    expect(calls()).toBe(0);
  });

  it("refuses without calling the LLM when the corpus is empty", async () => {
    const llm = new MockLlmProvider(() => "ignored");
    const engine = new AnswerEngine({ kb: new LexicalKnowledgeBase(), llm });
    const answer = await engine.answer("熵是什么?");
    expect(answer.refused).toBe(true);
    expect(answer.refusalReason).toBe("no_relevant_context");
    expect(answer.citations).toEqual([]);
  });

  it("embeds the refusal-first system prompt", () => {
    expect(GROUNDED_ANSWER_SYSTEM).toContain(REFUSAL_SENTINEL);
    expect(GROUNDED_ANSWER_SYSTEM).toContain("不得使用资料之外的任何知识");
  });
});
