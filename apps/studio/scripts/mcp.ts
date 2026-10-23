import { createInterface } from "node:readline";
import { applyProjectChanges, buildProject, planProject, verifyReceipt, type BuildInput, type PlanInput } from "./build";
import { proveProject } from "./prove";

/**
 * Minimal MCP (Model Context Protocol) server over stdio: newline-delimited
 * JSON-RPC 2.0. Glint exposes the four verbs agents actually need (plan, apply,
 * build, prove) plus verify, and every tool returns a machine-readable result.
 *
 * stdout carries protocol messages only; tool logs go to stderr.
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

const PROJECT = { type: "string", description: "Path to a SceneScript project JSON file" } as const;
const CHANGES = { type: "array", items: { type: "string" }, description: "Typed path=value edits, e.g. scenes[1].title=\"New\"" } as const;

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

export function defaultTools(): McpTool[] {
  const log = (message: string) => console.error(message);
  return [
    {
      name: "glint_plan",
      description: "Predict which build nodes a change will execute, what it costs and how long it takes. Does not render.",
      inputSchema: { type: "object", properties: { project: PROJECT, changes: CHANGES, tts: { type: "string" }, music: { type: "string" }, fast: { type: "boolean" } }, required: ["project"] },
      call: async (args) => {
        const report = planProject({ projectPath: stringArg(args, "project")!, changes: changesArg(args), tts: stringArg(args, "tts", false), music: stringArg(args, "music", false), fast: boolArg(args, "fast") });
        return { project: report.projectId, revision: report.revision, exact: report.exact, predicted: report.plan.predicted, changed: report.plan.changed, forced: report.plan.forced, reused: report.plan.reused, costCny: report.plan.costCny, estimatedMs: report.plan.estimatedMs, notes: report.notes };
      },
    },
    {
      name: "glint_apply",
      description: "Apply path=value edits to the project with compare-and-swap on the project revision.",
      inputSchema: { type: "object", properties: { project: PROJECT, changes: CHANGES, expectedRevision: { type: "string" } }, required: ["project", "changes"] },
      call: (args) => applyProjectChanges({ projectPath: stringArg(args, "project")!, changes: changesArg(args), expectedRevision: stringArg(args, "expectedRevision", false) }),
    },
    {
      name: "glint_build",
      description: "Build (render) a project, write a receipt next to the output, and compare actual execution with the predicted change set.",
      inputSchema: { type: "object", properties: { project: PROJECT, out: { type: "string" }, changes: CHANGES, tts: { type: "string" }, music: { type: "string" }, fast: { type: "boolean" }, plate: { type: "boolean" }, assertBudget: { type: "boolean" } }, required: ["project", "out"] },
      call: async (args) => {
        const input: BuildInput = {
          projectPath: stringArg(args, "project")!, output: stringArg(args, "out")!, changes: changesArg(args),
          tts: stringArg(args, "tts", false), music: stringArg(args, "music", false),
          fast: boolArg(args, "fast"), plate: boolArg(args, "plate"), log,
        };
        const report = await buildProject(input);
        if (boolArg(args, "assertBudget") && !report.budget.matches) throw new Error(`Build exceeded its predicted change set: missing=${report.budget.missing.join(",") || "-"} extra=${report.budget.extra.join(",") || "-"}`);
        return { output: report.output, receipt: `${report.output}.receipt.json`, matches: report.budget.matches, missing: report.budget.missing, extra: report.budget.extra, executed: report.receipt.totals.executed, reused: report.receipt.totals.reused, wallMs: report.elapsedMs, reproducibility: report.receipt.reproducibility };
      },
    },
    {
      name: "glint_prove",
      description: "Evaluate a glint.tests.json assertion file against a project, plan and optional receipt.",
      inputSchema: { type: "object", properties: { project: PROJECT, tests: { type: "string" }, receipt: { type: "string" }, changes: CHANGES }, required: ["project", "tests"] },
      call: (args) => proveProject({ projectPath: stringArg(args, "project")!, testsPath: stringArg(args, "tests")!, receiptPath: stringArg(args, "receipt", false), changes: changesArg(args) }),
    },
    {
      name: "glint_verify",
      description: "Validate a build receipt: output hash, environment drift, and optionally rebuild and compare.",
      inputSchema: { type: "object", properties: { receipt: { type: "string" }, rebuild: { type: "boolean" }, skipEnv: { type: "boolean" } }, required: ["receipt"] },
      call: (args) => verifyReceipt({ receiptPath: stringArg(args, "receipt")!, rebuild: boolArg(args, "rebuild"), skipEnvironment: boolArg(args, "skipEnv"), log }),
    },
  ];
}

export function createMcpHandler(tools: McpTool[] = defaultTools()): (request: unknown) => Promise<JsonRpcResponse | null> {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
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
        return respond(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "glint", version: "0.1.0" } });
      }
      if (parsed.method === "ping") return respond(id, {});
      if (parsed.method.startsWith("notifications/")) return isNotification ? null : respond(id, {});
      if (parsed.method === "tools/list") {
        return respond(id, { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      }
      if (parsed.method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = byName.get(name);
        if (!tool) return error(id, -32602, `Unknown tool: ${name || "(missing name)"}`);
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        try {
          const result = await tool.call(args);
          return respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (callError) {
          return respond(id, { content: [{ type: "text", text: callError instanceof Error ? callError.message : String(callError) }], isError: true });
        }
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
