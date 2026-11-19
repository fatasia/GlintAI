export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;
export type ComfyInput = { nodeId: string; input: string; value: string | number | boolean };
export type ComfyOutput = { nodeId: string; filename: string; subfolder: string; type: "output" | "temp" };
export type ComfyStatus = { promptId: string; state: "pending" | "running" | "success" | "failed" | "unknown"; outputs: ComfyOutput[] };
export type ComfyNodeCheck = { ok: boolean; checked: number; available: string[]; missing: string[] };
const META_LIMIT = 2 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const id = (value: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid ComfyUI prompt ID"); return value; };
const safeKey = (key: string) => !["__proto__", "constructor", "prototype"].includes(key);

/** Validate API-format nodes and patch only existing scalar inputs, never graph links. */
export function prepareComfyWorkflow(input: unknown, replacements: ComfyInput[] = []): ComfyWorkflow {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > META_LIMIT) throw new Error("ComfyUI workflow exceeds 2 MiB");
  const value: unknown = JSON.parse(serialized);
  if (!record(value) || !Object.keys(value).length || Object.keys(value).length > 4096) throw new Error("Expected ComfyUI API-format workflow");
  for (const [key, node] of Object.entries(value)) {
    if (!safeKey(key) || !record(node) || typeof node.class_type !== "string" || !node.class_type.trim() || !record(node.inputs)) throw new Error("Invalid ComfyUI node");
    if (Object.keys(node.inputs).some(key => !safeKey(key))) throw new Error("Invalid ComfyUI input key");
  }
  const workflow = value as ComfyWorkflow, seen = new Set<string>();
  for (const patch of replacements) {
    const node = Object.hasOwn(workflow, patch.nodeId) ? workflow[patch.nodeId] : undefined;
    const target = `${patch.nodeId}:${patch.input}`;
    if (!node || !safeKey(patch.input) || !Object.hasOwn(node.inputs, patch.input) || seen.has(target)) throw new Error("Invalid or duplicate ComfyUI input mapping");
    if (!["string", "number", "boolean"].includes(typeof patch.value) || typeof node.inputs[patch.input] !== typeof patch.value || typeof patch.value === "number" && !Number.isFinite(patch.value)) throw new Error("ComfyUI mapping must preserve a scalar input type");
    node.inputs[patch.input] = patch.value; seen.add(target);
  }
  if (Buffer.byteLength(JSON.stringify(workflow)) > META_LIMIT) throw new Error("ComfyUI workflow exceeds 2 MiB");
  return workflow;
}
function output(value: unknown, nodeId: string): ComfyOutput {
  if (!record(value) || typeof value.filename !== "string" || typeof value.subfolder !== "string" || !["output", "temp"].includes(String(value.type)) || "url" in value || "result_url" in value) throw new Error("Invalid ComfyUI output descriptor");
  const safePart = (part: string) => part.length > 0 && part !== "." && part !== ".." && !/[\\/:\x00-\x1f%?#]/.test(part);
  if (!safePart(value.filename) || value.filename.length > 255 || value.subfolder.length > 1024 || value.subfolder !== "" && !value.subfolder.split("/").every(safePart)) throw new Error("Unsafe ComfyUI output path");
  return { nodeId, filename: value.filename, subfolder: value.subfolder, type: value.type as ComfyOutput["type"] };
}
async function read(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`ComfyUI returned HTTP ${response.status}`); }
  if (!response.body) throw new Error("Empty ComfyUI response");
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) { await response.body.cancel(); throw new Error("ComfyUI response exceeds byte limit"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error("ComfyUI response exceeds byte limit"); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Explicit local execution, independent from the model registry and Studio UI. */
export class ComfyUIClient {
  private readonly base: string;
  constructor(endpoint: string) {
    const url = new URL(endpoint);
    if (!/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(endpoint) || !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("ComfyUI endpoint must be an explicit loopback origin (127.0.0.1 or [::1])");
    this.base = url.origin;
  }
  private async json(route: string, signal: AbortSignal, body?: unknown) {
    const response = await fetch(this.base + route, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal, redirect: "error" });
    const data: unknown = JSON.parse((await read(response, META_LIMIT)).toString("utf8"));
    if (!record(data)) throw new Error("Invalid ComfyUI metadata"); return data;
  }
  /** Inspect registered node classes only; no graph execution or model downloads. */
  async checkNodes(workflow: unknown, signal?: AbortSignal): Promise<ComfyNodeCheck> {
    const prepared = prepareComfyWorkflow(workflow), classes = [...new Set(Object.values(prepared).map(node => node.class_type))].sort();
    if (classes.length > 128 || classes.some(name => name.length > 256 || name === "." || name === ".." || /[\x00-\x1f]/.test(name))) throw new Error("ComfyUI node check exceeds class limits");
    const controller = new AbortController(), deadline = AbortSignal.timeout(20000);
    const combined = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
    const available = new Set<string>(), missing = new Set<string>(); let cursor = 0;
    const worker = async () => {
      while (cursor < classes.length) {
        combined.throwIfAborted(); const name = classes[cursor++]!;
        const info = await this.json(`/object_info/${encodeURIComponent(name)}`, combined);
        const keys = Object.keys(info);
        if (!keys.length) { missing.add(name); continue; }
        const node = info[name];
        if (keys.length !== 1 || !Object.hasOwn(info, name) || !record(node) || node.name !== name || !record(node.input) || !Array.isArray(node.output) || node.output.some(type => typeof type !== "string")) throw new Error("Invalid ComfyUI node metadata");
        available.add(name);
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(4, classes.length) }, worker)); combined.throwIfAborted(); }
    catch (error) { controller.abort(); throw error; }
    return { ok: missing.size === 0, checked: classes.length, available: classes.filter(name => available.has(name)), missing: classes.filter(name => missing.has(name)) };
  }
  /** Exactly one POST. A lost response is ambiguous: inspect history; do not automatically resubmit. */
  async submit(workflow: unknown, replacements: ComfyInput[] = [], signal = AbortSignal.timeout(30000)): Promise<string> {
    const prompt = prepareComfyWorkflow(workflow, replacements);
    const data = await this.json("/prompt", signal, { prompt });
    if (typeof data.prompt_id !== "string" || data.error || record(data.node_errors) && Object.keys(data.node_errors).length) throw new Error("ComfyUI submission unconfirmed; inspect history before retrying");
    return id(data.prompt_id);
  }
  private async history(promptId: string, signal: AbortSignal): Promise<ComfyStatus | null> {
    const data = await this.json(`/history/${id(promptId)}`, signal), entry = data[promptId];
    if (entry === undefined) return null;
    if (!record(entry) || !record(entry.status)) throw new Error("Invalid ComfyUI history");
    const status = entry.status;
    if (status.status_str === "error" || Array.isArray(status.messages) && status.messages.some(message => Array.isArray(message) && ["execution_error", "execution_interrupted"].includes(message[0]))) return { promptId, state: "failed", outputs: [] };
    if (status.completed !== true || status.status_str !== "success") throw new Error("Incomplete ComfyUI history");
    if (!record(entry.outputs)) throw new Error("Invalid ComfyUI outputs");
    const outputs: ComfyOutput[] = [];
    for (const [nodeId, node] of Object.entries(entry.outputs)) {
      if (!record(node)) throw new Error("Invalid ComfyUI node output");
      for (const kind of ["images", "gifs", "audio", "videos"]) {
        if (node[kind] === undefined) continue;
        if (!Array.isArray(node[kind])) throw new Error("Invalid ComfyUI output list");
        for (const item of node[kind]) outputs.push(output(item, nodeId));
      }
    }
    return { promptId, state: "success", outputs };
  }
  private async queue(signal: AbortSignal) {
    const data = await this.json("/queue", signal);
    for (const key of ["queue_running", "queue_pending"]) if (!Array.isArray(data[key]) || data[key].some(item => !Array.isArray(item) || typeof item[1] !== "string")) throw new Error("Invalid ComfyUI queue");
    return data as { queue_running: unknown[][]; queue_pending: unknown[][] };
  }
  /** Resume by persisted prompt ID; never submits work. Unknown includes deleted/expired history. */
  async status(promptId: string, signal = AbortSignal.timeout(20000)): Promise<ComfyStatus> {
    id(promptId); const completed = await this.history(promptId, signal); if (completed) return completed;
    const queue = await this.queue(signal);
    if (queue.queue_running.some(item => item[1] === promptId)) return { promptId, state: "running", outputs: [] };
    if (queue.queue_pending.some(item => item[1] === promptId)) return { promptId, state: "pending", outputs: [] };
    return await this.history(promptId, signal) ?? { promptId, state: "unknown", outputs: [] };
  }
  /** Only remove this queued prompt. A queue/run race may still start it; no global interrupt. */
  async cancelQueued(promptId: string, signal = AbortSignal.timeout(20000)): Promise<"delete-requested" | "not-queued"> {
    id(promptId); const queue = await this.queue(signal);
    if (queue.queue_running.some(item => item[1] === promptId) || !queue.queue_pending.some(item => item[1] === promptId)) return "not-queued";
    const response = await fetch(this.base + "/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }), signal, redirect: "error" });
    await read(response, META_LIMIT); return "delete-requested";
  }
  async download(file: ComfyOutput, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Buffer> {
    const checked = output(file, file.nodeId), limit = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) throw new Error("Invalid ComfyUI download byte limit");
    const query = new URLSearchParams({ filename: checked.filename, subfolder: checked.subfolder, type: checked.type });
    return read(await fetch(`${this.base}/view?${query}`, { signal: options.signal ?? AbortSignal.timeout(60000), redirect: "error" }), limit);
  }
}
