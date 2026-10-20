import { readSseData } from "@glintai/llm";

export interface GroundedAnswer {
  answer: string | null;
  refused: boolean;
  refusalReason: string | null;
  citations: Array<{ docId: string; headingPath: string[]; snippet: string }>;
  error?: string;
}

export async function consumeAnswerStream(response: Response, signal: AbortSignal): Promise<GroundedAnswer> {
  if (!response.ok) {
    throw new Error(`提问服务不可用 (HTTP ${response.status})，请检查服务器配置后重试。`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("提问服务未返回事件流，请检查服务器配置。");
  }
  for await (const data of readSseData(response.body, signal)) {
    const event = JSON.parse(data) as { type?: string; answer?: GroundedAnswer; error?: string };
    if (event.type === "error") throw new Error(event.error ?? "提问失败，请重试。");
    // Only the final verdict is safe to display; never trust provisional deltas.
    if (event.type === "done") {
      const answer = event.answer;
      if (!answer || typeof answer.refused !== "boolean" || !Array.isArray(answer.citations)
        || (!answer.refused && typeof answer.answer !== "string")) throw new Error("提问结果格式无效，请重试。");
      if (answer.error) throw new Error(answer.error);
      return { ...answer, answer: answer.refused ? null : answer.answer };
    }
  }
  throw new Error("回答传输中断，未收到最终结果，请重试。");
}
