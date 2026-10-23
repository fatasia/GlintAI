import { describe, expect, it } from "vitest";
import { createMcpHandler, defaultTools, type McpTool } from "./mcp";

const echo: McpTool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  call: (args) => ({ echoed: args.value }),
};

const failing: McpTool = {
  name: "explode",
  description: "Always fails",
  inputSchema: { type: "object", properties: {} },
  call: () => { throw new Error("boom"); },
};

describe("MCP handler", () => {
  const handle = createMcpHandler([echo, failing]);
  it("answers initialize with tools capability", async () => {
    const response = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(response?.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "glint" } });
  });
  it("lists tools without leaking their call functions", async () => {
    const response = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (response?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map(tool => tool.name)).toEqual(["echo", "explode"]);
    expect(tools[0]).not.toHaveProperty("call");
  });
  it("calls a tool and returns JSON text content", async () => {
    const response = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: "hi" } } });
    const result = response?.result as { content: { type: string; text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ echoed: "hi" });
  });
  it("turns tool exceptions into isError results instead of killing the server", async () => {
    const response = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "explode", arguments: {} } });
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("boom");
  });
  it("reports unknown tools, unknown methods and bad JSON", async () => {
    expect(((await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ghost" } }))?.error)?.code).toBe(-32602);
    expect(((await handle({ jsonrpc: "2.0", id: 6, method: "nope" }))?.error)?.code).toBe(-32601);
    expect(((await handle("{oops"))?.error)?.code).toBe(-32700);
    expect(((await handle({ jsonrpc: "1.0", id: 7, method: "ping" }))?.error)?.code).toBe(-32600);
  });
  it("never responds to notifications", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo", arguments: {} } })).toBeNull();
  });
});

describe("default tools", () => {
  it("exposes the four verbs plus verify with schemas", () => {
    const tools = defaultTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["glint_apply", "glint_build", "glint_plan", "glint_prove", "glint_verify"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  });
});
