import type { ChatRequest, LlmProvider } from "@glintai/llm";
import type {
  AsyncKnowledgeBase,
  KnowledgeBase,
  ScoredChunk,
} from "./retrieval";

export const REFUSAL_SENTINEL = "NOT_IN_SOURCE";

export const GROUNDED_ANSWER_SYSTEM = [
  "你是一个只依据给定资料回答问题的助手。",
  "规则:",
  "1. 只使用资料中明确包含的信息作答,不得使用资料之外的任何知识。",
  `2. 如果资料不足以回答问题,只输出一个词:${REFUSAL_SENTINEL},不要解释、不要补充。`,
  "3. 用与问题相同的语言回答,保持简洁。",
].join("\n");

export interface Citation {
  chunkId: string;
  docId: string;
  docTitle: string;
  headingPath: string[];
  snippet: string;
}

export type RefusalReason = "no_relevant_context" | "model_declined";

export interface GroundedAnswer {
  question: string;
  answer: string | null;
  refused: boolean;
  refusalReason: RefusalReason | null;
  citations: Citation[];
}

export interface AnswerEngineOptions {
  kb: KnowledgeBase | AsyncKnowledgeBase;
  llm: LlmProvider;
  topK?: number;
}

export type AnswerRequestOptions = Pick<ChatRequest, "signal" | "timeoutMs">;

const SNIPPET_LENGTH = 80;

function isAsync(kb: KnowledgeBase | AsyncKnowledgeBase): kb is AsyncKnowledgeBase {
  return typeof (kb as AsyncKnowledgeBase).searchAsync === "function";
}

function toCitations(hits: ScoredChunk[]): Citation[] {
  return hits.map((hit) => ({
    chunkId: hit.chunk.id,
    docId: hit.chunk.docId,
    docTitle: hit.chunk.docTitle,
    headingPath: hit.chunk.headingPath,
    snippet:
      hit.chunk.text.length > SNIPPET_LENGTH
        ? `${hit.chunk.text.slice(0, SNIPPET_LENGTH)}…`
        : hit.chunk.text,
  }));
}

/**
 * Refusal-first grounded QA. The model may only answer from retrieved
 * chunks; anything else — including a blank reply — is treated as a
 * refusal. Citations always describe the retrieved context, even when
 * the answer is refused.
 */
export class AnswerEngine {
  constructor(private readonly options: AnswerEngineOptions) {}

  async answer(question: string, options: AnswerRequestOptions = {}): Promise<GroundedAnswer> {
    options.signal?.throwIfAborted();
    const { kb, llm, topK = 5 } = this.options;
    if (!question.trim()) {
      return {
        question,
        answer: null,
        refused: true,
        refusalReason: "no_relevant_context",
        citations: [],
      };
    }

    const hits = isAsync(kb)
      ? await kb.searchAsync(question, topK)
      : kb.search(question, topK);
    options.signal?.throwIfAborted();
    if (hits.length === 0) {
      return {
        question,
        answer: null,
        refused: true,
        refusalReason: "no_relevant_context",
        citations: [],
      };
    }

    const context = hits
      .map(
        (hit, i) =>
          `[${i + 1}] (${hit.chunk.docTitle} › ${hit.chunk.headingPath.join(" › ")})\n${hit.chunk.text}`,
      )
      .join("\n\n");

    const response = await llm.chat({
      ...options,
      system: GROUNDED_ANSWER_SYSTEM,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: `资料:\n${context}\n\n问题:${question}`,
        },
      ],
    });

    options.signal?.throwIfAborted();
    const trimmed = response.text.trim();
    if (!trimmed || trimmed.toUpperCase().includes(REFUSAL_SENTINEL)) {
      return {
        question,
        answer: null,
        refused: true,
        refusalReason: "model_declined",
        citations: toCitations(hits),
      };
    }
    return {
      question,
      answer: trimmed,
      refused: false,
      refusalReason: null,
      citations: toCitations(hits),
    };
  }

  /**
   * Citations describe retrieved evidence, not a guarantee of factual entailment.
   * Buffer model text until the full refusal verdict; a sentinel may arrive last.
   * Thus only citations stream early; accepted answer text is emitted once.
   */
  async *streamAnswer(
    question: string,
    options: AnswerRequestOptions = {},
  ): AsyncGenerator<StreamEvent, void, unknown> {
    options.signal?.throwIfAborted();
    const { kb, llm, topK = 5 } = this.options;
    const refusedNow = (
      reason: RefusalReason,
    ): GroundedAnswer => ({
      question,
      answer: null,
      refused: true,
      refusalReason: reason,
      citations: [],
    });

    if (!question.trim()) {
      yield { type: "done", answer: refusedNow("no_relevant_context") };
      return;
    }
    const hits = isAsync(kb)
      ? await kb.searchAsync(question, topK)
      : kb.search(question, topK);
    options.signal?.throwIfAborted();
    if (hits.length === 0) {
      yield { type: "done", answer: refusedNow("no_relevant_context") };
      return;
    }
    const citations = toCitations(hits);
    yield { type: "citations", citations };

    const context = hits
      .map(
        (hit, i) =>
          `[${i + 1}] (${hit.chunk.docTitle} › ${hit.chunk.headingPath.join(" › ")})\n${hit.chunk.text}`,
      )
      .join("\n\n");

    const collected: string[] = [];
    if (typeof llm.chatStream === "function") {
      for await (const delta of llm.chatStream({
        ...options,
        system: GROUNDED_ANSWER_SYSTEM,
        temperature: 0.1,
        messages: [
          { role: "user", content: `资料:\n${context}\n\n问题:${question}` },
        ],
      })) {
        options.signal?.throwIfAborted();
        collected.push(delta);
      }
    } else {
      const response = await llm.chat({
        ...options,
        system: GROUNDED_ANSWER_SYSTEM,
        temperature: 0.1,
        messages: [
          { role: "user", content: `资料:\n${context}\n\n问题:${question}` },
        ],
      });
      collected.push(response.text);
    }

    options.signal?.throwIfAborted();
    const trimmed = collected.join("").trim();
    const answer: GroundedAnswer =
      !trimmed || trimmed.toUpperCase().includes(REFUSAL_SENTINEL)
        ? {
            question,
            answer: null,
            refused: true,
            refusalReason: "model_declined",
            citations,
          }
        : {
            question,
            answer: trimmed,
            refused: false,
            refusalReason: null,
            citations,
          };
    if (answer.answer) yield { type: "delta", text: answer.answer };
    yield { type: "done", answer };
  }
}

export type StreamEvent =
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done"; answer: GroundedAnswer };
