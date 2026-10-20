import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicProvider, OpenAICompatibleProvider } from "./index";

let server: Server;
let baseUrl: string;
let lastRequest: Record<string, unknown>;
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      lastRequest = body;
      if (req.url?.startsWith("/hang-headers")) return;
      if (req.url?.startsWith("/hang-body")) {
        res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
        res.flushHeaders(); return;
      }
      if (req.url?.endsWith("/v1/messages")) {
        res.end(JSON.stringify({ content: [{ type: "text", text: "single response" }] })); return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"中文😀"}}]}\r\n\r\ndata: [DONE]\r\n\r\ndata: invalid\r\n\r\n');
      let index = 0;
      const timer = setInterval(() => {
        if (index === bytes.length) { clearInterval(timer); res.end(); }
        else res.write(bytes.subarray(index, ++index));
      }, 1);
      res.on("close", () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const config = (path = "") => ({ baseUrl: baseUrl + path, apiKey: "local-test-only", model: "test" });
it("decodes real HTTP single-byte UTF8 and CRLF fragments and stops at DONE", async () => {
  let text = "";
  for await (const delta of new OpenAICompatibleProvider(config()).chatStream({ messages: [] })) text += delta;
  expect(text).toBe("中文😀");
  expect(lastRequest.stream).toBe(true);
});
it.each(["/hang-headers", "/hang-body"])("request timeout override covers %s for both protocols", async (path) => {
  for (const provider of [new OpenAICompatibleProvider({ ...config(path), timeoutMs: 5000 }), new AnthropicProvider({ ...config(path), timeoutMs: 5000 })]) {
    await expect(provider.chat({ messages: [], timeoutMs: 80 })).rejects.toThrow("timed out after 80ms");
  }
  const stream = new OpenAICompatibleProvider({ ...config(path), timeoutMs: 5000 }).chatStream({ messages: [], timeoutMs: 80 });
  await expect(stream.next()).rejects.toThrow("timed out after 80ms");
});
it("cancels real pending stream reads without misreporting timeout", async () => {
  const controller = new AbortController();
  const stream = new OpenAICompatibleProvider(config("/hang-body")).chatStream({ messages: [], signal: controller.signal });
  const pending = stream.next();
  setTimeout(() => controller.abort(new Error("caller cancelled")), 40);
  await expect(pending).rejects.toThrow("caller cancelled");
});
it("Anthropic makes one non-streaming request", async () => {
  const provider = new AnthropicProvider(config());
  expect("chatStream" in provider).toBe(false);
  expect((await provider.chat({ messages: [] })).text).toBe("single response");
  expect(lastRequest).not.toHaveProperty("stream");
});
