import { expect, it } from "vitest";
import { consumeAnswerStream } from "./answer-stream";
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const answer = { answer: "中文😀", refused: false, refusalReason: null, citations: [] };
it("handles fragmented CRLF UTF8 and final event at EOF", async () => {
  expect(await consumeAnswerStream(response(`data: ${JSON.stringify({ type: "done", answer })}`), new AbortController().signal)).toEqual(answer);
});
it("discards provisional text when final verdict refuses", async () => {
  const res = response(`data: {"type":"delta","text":"NOT_IN_SOURCE"}\r\n\r\ndata: ${JSON.stringify({ type: "done", answer: { ...answer, refused: true } })}\r\n\r\n`);
  expect((await consumeAnswerStream(res, new AbortController().signal)).answer).toBeNull();
});
it("rejects truncated, invalid, non-SSE and HTTP error responses", async () => {
  const signal = new AbortController().signal;
  await expect(consumeAnswerStream(response('data: {"type":"delta","text":"partial"}\n\n'), signal)).rejects.toThrow("中断");
  await expect(consumeAnswerStream(response('data: broken\n\n'), signal)).rejects.toThrow();
  await expect(consumeAnswerStream(new Response("html"), signal)).rejects.toThrow("事件流");
  await expect(consumeAnswerStream(new Response("private error", { status: 503 }), signal)).rejects.toThrow("HTTP 503");
});
it("surfaces terminal errors without producing an answer", async () => {
  await expect(consumeAnswerStream(response('data: {"type":"error","error":"retry"}\n\n'), new AbortController().signal)).rejects.toThrow("retry");
});
