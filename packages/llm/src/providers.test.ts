import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { MockLlmProvider, OpenAICompatibleProvider } from "./index";

describe("MockLlmProvider", () => {
  it("returns scripted replies", async () => {
    const provider = new MockLlmProvider(
      (req) => `echo:${req.messages[0]?.content ?? ""}`,
    );
    const res = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("echo:hi");
  });
});

describe("OpenAICompatibleProvider", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        if (url.endsWith("/chat/completions")) {
          if (req.headers.authorization !== "Bearer test-key") {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "bad key" } }));
            return;
          }
          const parsed = JSON.parse(body) as {
            messages: Array<{ role: string }>;
          };
          const hasSystem = parsed.messages.some((m) => m.role === "system");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { content: hasSystem ? "system-ok" : "pong" } },
              ],
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("extracts the completion text and injects the system message", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: "test-key",
      model: "glm-4",
    });
    const res = await provider.chat({
      system: "be nice",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(res.text).toBe("system-ok");
  });

  it("turns HTTP errors into actionable LlmHttpError", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: "wrong",
      model: "glm-4",
    });
    await expect(
      provider.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/HTTP 401[\s\S]*Check your LLM baseUrl/);
  });

  it("fails with a readable timeout against a hanging server", async () => {
    const hang = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
      apiKey: "k",
      model: "m",
      timeoutMs: 100,
    });
    await expect(
      provider.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/timed out after 100ms/);
    hang.closeAllConnections();
    hang.close();
  });

  it("reports connection failures with the endpoint", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:9", // discard port, nothing listens
      apiKey: "k",
      model: "m",
      timeoutMs: 2000,
    });
    await expect(
      provider.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/failed: /);
  });

  it("rejects empty completions instead of returning blank text", async () => {
    const empty = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    });
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve));
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: `http://127.0.0.1:${(empty.address() as AddressInfo).port}`,
        apiKey: "k",
        model: "m",
      });
      await expect(
        provider.chat({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toThrow(/empty completion/);
    } finally {
      empty.closeAllConnections();
      empty.close();
    }
  });
});
