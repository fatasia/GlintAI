import { createInterface } from "node:readline";
import { applySessionChanges, buildProject, planProject, verifyReceipt, type BuildInput, type PlanInput } from "./build";
import { proveProject } from "./prove";
import { taskTools } from "./task-mcp";
import { containerTools } from "./container-mcp";
import { toolMeta } from "./mcp-registry";
import { INLINE_PLAYER_URI, inlinePlayerResource, isMcpAppClient, readInlinePlayerResource, showVideoResultPayload, showVideoTool } from "./mcp-apps";
/**
 * Minimal MCP (Model Context Protocol) server over stdio: newline-delimited
 * JSON-RPC 2.0. Glint exposes the four verbs agents actually need (plan, apply,
 * build, prove) plus verify, and every tool returns a machine-readable result.
 *
 * stdout carries protocol messages only; tool logs go to stderr.
 * Tool metadata (name/description/inputSchema) comes from ./mcp-registry (M-06d).
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<unknown> | unknown;
}

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined) {
    if (required) throw new Error(`Missing required argument: ${name}`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`Argument ${name} must be a non-empty string`);
  return value;
}

function changesArg(args: Record<string, unknown>): string[] {
  const value = args.changes;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error("changes must be an array of strings");
  if (value.length > 200) throw new Error("Too many changes (max 200)");
  return value as string[];
}

function boolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Argument ${name} must be a boolean`);
  return value;
}

export function defaultTools(options: { sessionDirectory?: string } = {}): McpTool[] {
  const log = (message: string) => console.error(message);
  return [
    ...containerTools(),
    ...taskTools(),
    {
      ...toolMeta("glint_plan"),
      call: async (args) => {
        const report = planProject({ projectPath: stringArg(args, "project")!, changes: changesArg(args), tts: stringArg(args, "tts", false), music: stringArg(args, "music", false), fast: boolArg(args, "fast") });
        return { project: report.projectId, revision: report.revision, exact: report.exact, predicted: report.plan.predicted, changed: report.plan.changed, forced: report.plan.forced, reused: report.plan.reused, costCny: report.plan.costCny, modelCalls: report.modelCalls, estimatedMs: report.plan.estimatedMs, notes: report.notes };
      },
    },
    {
      ...toolMeta("glint_apply"),
      call: (args) => applySessionChanges({ projectPath: stringArg(args, "project")!, changes: changesArg(args), expectedRevision: stringArg(args, "expectedRevision", false), sessionDirectory: options.sessionDirectory }),
    },
    {
      ...toolMeta("glint_build"),
      call: async (args) => {
        const input: BuildInput = {
          projectPath: stringArg(args, "project")!, output: stringArg(args, "out")!, changes: changesArg(args),
          tts: stringArg(args, "tts", false), music: stringArg(args, "music", false),
          fast: boolArg(args, "fast"), plate: boolArg(args, "plate"), assertBudget: boolArg(args, "assertBudget"), log,
        };
        const report = await buildProject(input);
        if (boolArg(args, "assertBudget") && !report.budget.matches) throw new Error(`Build exceeded its predicted change set: missing=${report.budget.missing.join(",") || "-"} extra=${report.budget.extra.join(",") || "-"}`);
        return { output: report.output, receipt: `${report.output}.receipt.json`, matches: report.budget.matches, missing: report.budget.missing, extra: report.budget.extra, executed: report.receipt.totals.executed, reused: report.receipt.totals.reused, wallMs: report.elapsedMs, reproducibility: report.receipt.reproducibility };
      },
    },
    {
      ...toolMeta("glint_prove"),
      call: (args) => proveProject({ projectPath: stringArg(args, "project")!, testsPath: stringArg(args, "tests")!, receiptPath: stringArg(args, "receipt", false), changes: changesArg(args) }),
    },
    {
      ...toolMeta("glint_verify"),
      call: (args) => verifyReceipt({ receiptPath: stringArg(args, "receipt")!, rebuild: boolArg(args, "rebuild"), skipEnvironment: boolArg(args, "skipEnv"), log }),
    },
  ];
}

export function createMcpHandler(tools: McpTool[] = defaultTools()): (request: unknown) => Promise<JsonRpcResponse | null> {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  // MCP Apps negotiation is per-connection state; the stdio server serves one connection.
  let appCapable = false;
  return async (request: unknown): Promise<JsonRpcResponse | null> => {
    let parsed: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = typeof request === "string" ? JSON.parse(request) : request as typeof parsed;
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") return { jsonrpc: "2.0", id: (parsed?.id ?? null) as Id, error: { code: -32600, message: "Invalid Request" } };
    const id = parsed.id === undefined ? undefined : parsed.id as Id;
    const isNotification = id === undefined;
    const params = (parsed.params && typeof parsed.params === "object" ? parsed.params : {}) as Record<string, unknown>;
    try {
      if (parsed.method === "initialize") {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
        appCapable = isMcpAppClient(params);
        return respond(id, { protocolVersion: requested, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "glint", version: "0.1.0" } });
      }
      if (parsed.method === "ping") return respond(id, {});
      if (parsed.method.startsWith("notifications/")) return isNotification ? null : respond(id, {});
      if (parsed.method === "tools/list") {
        const listed = appCapable ? [...tools, showVideoTool()] : tools;
        return respond(id, { tools: listed.map(tool => ({
          name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          ...(tool.name === "glint_show_video" ? { _meta: { ui: { resourceUri: INLINE_PLAYER_URI } } } : {}),
        })) });
      }
      if (parsed.method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = byName.get(name) ?? (appCapable && name === "glint_show_video" ? showVideoTool() : undefined);
        if (!tool) return error(id, -32602, `Unknown tool: ${name || "(missing name)"}`);
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        try {
          const result = await tool.call(args);
          if (name === "glint_show_video") return respond(id, showVideoResultPayload(result));
          return respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (callError) {
          return respond(id, { content: [{ type: "text", text: callError instanceof Error ? callError.message : String(callError) }], isError: true });
        }
      }
      if (parsed.method === "resources/list") {
        return respond(id, { resources: [inlinePlayerResource()] });
      }
      if (parsed.method === "resources/read") {
        const uri = typeof params.uri === "string" ? params.uri : "";
        const resource = readInlinePlayerResource(uri);
        if (!resource) return error(id, -32602, `Unknown resource: ${uri || "(missing uri)"}`);
        return respond(id, { contents: [resource] });
      }
      return error(id, -32601, `Method not found: ${parsed.method}`);
    } catch (internal) {
      return error(id, -32603, internal instanceof Error ? internal.message : String(internal));
    }
  };
}

function respond(id: Id | undefined, result: unknown): JsonRpcResponse | null {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result };
}
function error(id: Id | undefined, code: number, message: string): JsonRpcResponse | null {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Newline-delimited JSON-RPC over the given streams (stdio by default). */
export async function runMcpServer(options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; tools?: McpTool[] } = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const handle = createMcpHandler(options.tools ?? defaultTools());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const response = await handle(line);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
