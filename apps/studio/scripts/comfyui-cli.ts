import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { ComfyUIClient, prepareComfyWorkflow, type ComfyInput } from "@glintai/media";
const LIMIT = 2 * 1024 * 1024;
class CliError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new CliError(code); };
async function readJson(file: string): Promise<unknown> {
  file = path.resolve(process.env.INIT_CWD || process.cwd(), file);
  if (!(await fs.lstat(file)).isFile()) return fail("input-not-regular-file");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile()) return fail("input-not-regular-file");
    if (stat.size > LIMIT) return fail("input-too-large");
    const buffer = Buffer.alloc(LIMIT + 1); let size = 0;
    while (size < buffer.length) { const next = await handle.read(buffer, size, buffer.length - size, null); if (!next.bytesRead) break; size += next.bytesRead; }
    if (size > LIMIT) return fail("input-too-large");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}
function mappings(value: unknown): ComfyInput[] {
  if (!Array.isArray(value) || value.length > 4096) return fail("invalid-input-mappings");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["nodeId", "input", "value"].includes(key))) return fail("invalid-input-mappings");
    const patch = item as Record<string, unknown>;
    if (typeof patch.nodeId !== "string" || typeof patch.input !== "string" || !["string", "number", "boolean"].includes(typeof patch.value)) return fail("invalid-input-mappings");
    return { nodeId: patch.nodeId, input: patch.input, value: patch.value as string | number | boolean };
  });
}
/** Explicit local execution; one command invocation never retries submission. */
export async function runComfyUI(args: string[], write: (line: string) => void = console.log): Promise<number> {
  let submitting = false;
  try {
    const action = args[0];
    if (!["submit", "status", "cancel", "download", "check"].includes(action ?? "")) return fail("invalid-action");
    const allowed = new Set(action === "check" ? ["endpoint", "workflow"] : action === "submit" ? ["endpoint", "workflow", "inputs", "confirm-execute"] : action === "download" ? ["endpoint", "id", "output-index", "out", "max-bytes"] : ["endpoint", "id"]);
    const flags = new Map<string, string>();
    for (const arg of args.slice(1)) {
      const match = /^--([^=]+)=(.+)$/.exec(arg), key = arg === "--confirm-execute" ? "confirm-execute" : match?.[1];
      if (!key || !allowed.has(key) || flags.has(key) || key === "confirm-execute" && arg !== "--confirm-execute") return fail("invalid-argument");
      flags.set(key, match?.[2] ?? "true");
    }
    const required = (key: string) => flags.get(key) ?? fail(`${key}-required`);
    const client = new ComfyUIClient(required("endpoint"));
    if (action === "check") {
      const result = await client.checkNodes(await readJson(required("workflow")));
      write(JSON.stringify(result)); return result.ok ? 0 : 2;
    }
    if (action === "submit") {
      if (!flags.has("confirm-execute")) return fail("confirmation-required");
      const workflow = await readJson(required("workflow")), inputs = flags.has("inputs") ? mappings(await readJson(required("inputs"))) : [];
      const prepared = prepareComfyWorkflow(workflow, inputs);
      submitting = true; const promptId = await client.submit(prepared);
      write(JSON.stringify({ promptId, submitted: true })); return 0;
    }
    const promptId = required("id");
    if (action === "status") { write(JSON.stringify(await client.status(promptId))); return 0; }
    if (action === "cancel") { write(JSON.stringify({ promptId, cancellation: await client.cancelQueued(promptId) })); return 0; }
    const indexText = required("output-index"), destination = path.resolve(process.env.INIT_CWD || process.cwd(), required("out"));
    if (!/^(0|[1-9][0-9]*)$/.test(indexText) || !Number.isSafeInteger(Number(indexText))) return fail("invalid-output-index");
    const limitText = flags.get("max-bytes"), maxBytes = limitText === undefined ? undefined : Number(limitText);
    if (limitText !== undefined && (!/^[1-9][0-9]*$/.test(limitText) || !Number.isSafeInteger(maxBytes) || maxBytes! > 512 * 1024 * 1024)) return fail("invalid-byte-limit");
    const task = await client.status(promptId);
    if (task.state !== "success") return fail("prompt-not-successful");
    const output = task.outputs[Number(indexText)]; if (!output) return fail("output-index-not-found");
    const bytes = await client.download(output, { maxBytes });
    const handle = await fs.open(destination, "wx");
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    write(JSON.stringify({ promptId, outputIndex: Number(indexText), path: destination, bytes: bytes.length })); return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "output-exists" : "request-failed";
    write(JSON.stringify({ error: submitting ? "submission-unconfirmed" : code, ...(submitting ? { retryAutomatically: false, recovery: "Inspect ComfyUI history before any new submission" } : {}) })); return 2;
  }
}
