import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createLlmProvider } from "./configuration";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const reply = { choices: [{ message: { content: "OK" } }], content: [{ type: "text", text: "OK" }] };
const protocols = ["openai", "anthropic"] as const;

for (const protocol of protocols) {
  it.each([302, 307, 308])(`${protocol} rejects HTTP %i before a second origin receives the request`, async status => {
    let destinationCalls = 0, authenticatedSourceCalls = 0;
    const destination = await listen(http.createServer((_request, response) => {
      destinationCalls++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(reply));
    }));
    const source = await listen(http.createServer((request, response) => {
      const credential = protocol === "anthropic" ? request.headers["x-api-key"] : request.headers.authorization;
      if (credential === (protocol === "anthropic" ? "fixture-only" : "Bearer fixture-only")) authenticatedSourceCalls++;
      response.writeHead(status, { location: `${destination}/capture` }); response.end();
    }));
    const provider = createLlmProvider({ baseUrl: source, apiKey: "fixture-only", model: "fixture", protocol });
    await expect(provider.chat({ messages: [{ role: "user", content: "fixture" }], maxOutputTokens: 64 })).rejects.toThrow();
    expect(authenticatedSourceCalls).toBe(1); expect(destinationCalls).toBe(0);
  });

  it(`${protocol} still sends one authenticated, bounded normal request`, async () => {
    let calls = 0, authenticated = false, budget: number | undefined;
    const source = await listen(http.createServer(async (request, response) => {
      calls++; const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      budget = protocol === "anthropic" ? body.max_tokens : body.max_completion_tokens;
      authenticated = protocol === "anthropic" ? request.headers["x-api-key"] === "fixture-only" : request.headers.authorization === "Bearer fixture-only";
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(reply));
    }));
    const provider = createLlmProvider({ baseUrl: source, apiKey: "fixture-only", model: "fixture", protocol });
    expect(await provider.chat({ messages: [{ role: "user", content: "fixture" }], json: true, maxOutputTokens: 64 })).toEqual({ text: "OK" });
    expect(calls).toBe(1); expect(authenticated).toBe(true); expect(budget).toBe(64);
  });
}
