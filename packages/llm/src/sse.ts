/** Decode SSE data payloads without assuming byte, line or event chunk boundaries. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxEventChars = 1_048_576;
  let buffer = "";
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > maxEventChars) throw new Error("SSE event exceeds 1 MiB");
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = dataOf(event);
        if (data !== null) yield data;
        signal?.throwIfAborted();
      }
      if (buffer.length > maxEventChars) throw new Error("SSE event exceeds 1 MiB");
      if (done) {
        // Some compatible gateways omit the last blank line before closing.
        const data = dataOf(buffer);
        if (data !== null) yield data;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function dataOf(event: string): string | null {
  const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!lines.length) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}
