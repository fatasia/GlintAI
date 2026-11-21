import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { createMcpHandler, defaultTools, type McpTool } from "./mcp";
import { MCP_TOOL_REGISTRY } from "./mcp-registry";

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
  it("assembles exactly the registry catalog (M-06d) with schemas", () => {
    const tools = defaultTools();
    // The hand-copied list is gone: the registry is the single source the test derives from.
    expect(tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOL_REGISTRY.map((spec) => spec.name).sort());
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  });
  it("keeps one registry entry per default tool (count guard)", () => {
    expect(MCP_TOOL_REGISTRY).toHaveLength(defaultTools().length);
  });
  it("routes glint_apply through the shared session domain (CORE-09)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-mcp-"));
    const sessionDirectory = path.join(root, "sessions");
    const projectPath = path.join(root, "p.project.json");
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, id: "mcp-target", title: "原题", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "开场", narration: { text: "第一句" } }] }));
    const tools = defaultTools({ sessionDirectory });
    const apply = tools.find(tool => tool.name === "glint_apply")!;
    const result = await apply.call({ project: projectPath, changes: ['title="MCP 新题"', 'scenes[0].title="新开场"'] }) as { projectId: string; revision: string };
    expect(result.projectId).toBe("mcp-target");
    // The file is updated AND the session domain carries the same edit.
    expect(JSON.parse(fs.readFileSync(projectPath, "utf8")).title).toBe("MCP 新题");
    const store = new FileSessionStore(sessionDirectory);
    const { snapshot } = store.snapshot("mcp-target");
    expect(snapshot.revision).toBe(1);
    // The change is undoable through the same session line.
    const undone = store.historyEdit("mcp-target", "undo", "undo-1", 1, "user");
    expect(undone.receipt.stage).toBe("verified");
    expect((store.snapshot("mcp-target").snapshot.document as { title: string }).title).toBe("原题");
    // A stale CAS on the file hash still conflicts.
    expect(() => apply.call({ project: projectPath, changes: ['title="晚到的一笔"'], expectedRevision: "sha256:stale" })).toThrow(/Revision conflict/);
  });
});

describe("MCP Apps: inline player negotiation (P4, OpenMotion-shaped)", () => {
  const appCaps = { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } };
  async function initialize(handle: (request: unknown) => Promise<unknown>, caps: Record<string, unknown> = {}) {
    return handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", ...caps } })) as Promise<any>;
  }
  it("negotiates mcp-app clients: show_video appears with its resourceUri, plain clients never see it", async () => {
    const handle = createMcpHandler();
    const plain = await initialize(handle);
    expect(plain.result.capabilities.resources).toEqual({});
    const plainList = await handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    expect(plainList.result.tools.some((t: any) => t.name === "glint_show_video")).toBe(false);
    const app = await initialize(handle, appCaps);
    expect(app.result.capabilities.resources).toEqual({});
    const appList = await handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as any;
    const show = appList.result.tools.find((t: any) => t.name === "glint_show_video");
    expect(show).toBeTruthy();
    expect(show._meta).toEqual({ ui: { resourceUri: "glint://inline-player" } });
    const sixteen = await handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as any;
    expect(sixteen.result.tools.filter((t: any) => t.name !== "glint_show_video")).toHaveLength(16);
  });
  it("serves the self-contained player shell with the OpenMotion CSP shape", async () => {
    const handle = createMcpHandler(); await initialize(handle, appCaps);
    const listed = await handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" })) as any;
    expect(listed.result.resources).toEqual([expect.objectContaining({ uri: "glint://inline-player", mimeType: "text/html;profile=mcp-app" })]);
    const read = await handle(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "glint://inline-player" } })) as any;
    const shell = read.result.contents[0];
    expect(shell.mimeType).toBe("text/html;profile=mcp-app");
    expect(shell.text).toContain("glint:video");
    expect(shell._meta.ui.csp.resourceDomains).toContain("data:");
    expect(shell._meta["openai/ui"].preferredDisplayMode).toBe("inline");
    const missing = await handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "glint://other" } })) as any;
    expect(missing.error.code).toBe(-32602);
  });
  it("glint_show_video embeds small files as data URLs and rejects oversized ones", async () => {
    const handle = createMcpHandler(); await initialize(handle, appCaps);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-show-video-"));
    try {
      const small = path.join(root, "clip.mp4");
      fs.writeFileSync(small, Buffer.alloc(2048, 7));
      const shown = await handle(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "glint_show_video", arguments: { file: small, title: "验收片" } } })) as any;
      expect(shown.result.isError).toBeFalsy();
      const structured = shown.result.structuredContent as Record<string, unknown>;
      expect(structured.kind).toBe("glint:video");
      expect(structured.title).toBe("验收片");
      expect(String(structured.src).startsWith("data:video/mp4;base64,")).toBe(true);
      expect(shown.result._meta).toEqual({ ui: { resourceUri: "glint://inline-player" } });
      const oversized = path.join(root, "big.mp4");
      fs.writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 1));
      const rejected = await handle(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "glint_show_video", arguments: { file: oversized } } })) as any;
      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.content[0].text).toContain("8MiB");
      const missing = await handle(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "glint_show_video", arguments: { file: path.join(root, "nope.mp4") } } })) as any;
      expect(missing.result.isError).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects glint_show_video on hosts that never negotiated MCP Apps", async () => {
    const handle = createMcpHandler(); await initialize(handle);
    const denied = await handle(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "glint_show_video", arguments: { file: "x.mp4" } } })) as any;
    expect(denied.error?.code).toBe(-32602);
  });
});
