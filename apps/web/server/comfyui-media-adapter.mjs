import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "@glintai/session";
import { ComfyUIClient, prepareComfyWorkflow } from "@glintai/media";
const sha = value => createHash("sha256").update(value).digest("hex");
const reject = (code, status = 400) => { throw Object.assign(new Error(code), { status, code }); };
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const types = { image: ["png", "jpg", "webp"], video: ["mp4"], audio: ["mp3", "wav"] };
function matches(bytes, extension) {
  const head = bytes.subarray(0, 12), hex = head.toString("hex");
  return extension === "png" ? hex.startsWith("89504e470d0a1a0a") : extension === "jpg" ? hex.startsWith("ffd8ff") :
    extension === "webp" ? head.subarray(0, 4).toString() === "RIFF" && head.subarray(8).toString() === "WEBP" :
    extension === "mp4" ? head.subarray(4, 8).toString() === "ftyp" : extension === "wav" ? head.subarray(0, 4).toString() === "RIFF" && head.subarray(8).toString() === "WAVE" :
    extension === "mp3" && (head.subarray(0, 3).toString() === "ID3" || bytes[0] === 255 && (bytes[1] & 224) === 224);
}
function safeJson(value, depth = 0) {
  if (depth > 64) reject("Invalid workflow depth");
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) reject("Invalid workflow key");
    safeJson(value[key], depth + 1);
  }
}
function prepared(input) {
  safeJson(input);
  if (input.inputs !== undefined && (!Array.isArray(input.inputs) || input.inputs.length > 256 || input.inputs.some(item => !item || Object.keys(item).some(key => !["nodeId", "input", "value"].includes(key))))) reject("Invalid input mappings");
  return prepareComfyWorkflow(input.workflow, input.inputs ?? []);
}
async function checkNodes(client, workflow, signal) {
  try { return { ...await client.checkNodes(workflow, signal), submitted: false }; }
  catch { throw Object.assign(new Error("Local workflow node check failed"), { status: 503, code: "node-check-failed", submitted: false }); }
}
export function createComfyMediaAdapter({ root, env, writer, asset, probe }) {
  let executionGuard;
  const realRoot = fs.realpathSync(root), pendingImports = new Map();
  const guard = () => {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== realRoot) reject("Media library changed", 409);
  };
  function read(name, maxBytes = 4 * 1024 * 1024) {
    guard(); const file = path.join(root, name);
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) reject("Invalid media record", 409);
    const value = JSON.parse(fs.readFileSync(file, "utf8")); safeJson(value); return value;
  }
  function save(name, value, exclusive = false) {
    guard(); const file = path.join(root, name);
    if (exclusive) { fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); return; }
    read(name); const temporary = path.join(root, `.comfy-record-${randomUUID()}.part`);
    try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); guard(); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  const settingsName = "comfyui-settings.json";
  function config() {
    const saved = read(settingsName, 1024);
    if (saved === null && fs.existsSync(path.join(root, settingsName))) reject("Invalid local workflow settings", 409);
    if (saved !== null) {
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || Object.keys(saved).length !== 1 || typeof saved.endpoint !== "string") reject("Invalid local workflow settings", 409);
      try { new ComfyUIClient(saved.endpoint); } catch { reject("Invalid local workflow settings", 409); }
      return { configured: true, endpoint: new URL(saved.endpoint).origin, source: "saved" };
    }
    const endpoint = env.GLINT_COMFYUI_ENDPOINT;
    if (!endpoint) return { configured: false, endpoint: null, source: "none" };
    try { new ComfyUIClient(endpoint); return { configured: true, endpoint: new URL(endpoint).origin, source: "environment" }; }
    catch { return { configured: false, endpoint: null, source: "environment" }; }
  }
  function configure(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "endpoint") || input.endpoint !== null && typeof input.endpoint !== "string") reject("Invalid local workflow settings");
    config(); // Do not overwrite or silently ignore a corrupt saved record.
    if (input.endpoint === null) { guard(); if (read(settingsName, 1024) !== null) fs.unlinkSync(path.join(root, settingsName)); }
    else { new ComfyUIClient(input.endpoint); save(settingsName, { endpoint: new URL(input.endpoint).origin }); }
    return config();
  }
  function connection() {
    const settings = config();
    if (!settings.configured) reject("Local workflow service is not configured", 503);
    return { client: new ComfyUIClient(settings.endpoint), endpointHash: sha(settings.endpoint) };
  }
  function task(id) {
    if (typeof id !== "string" || !id.startsWith("comfy-") || !identifier(id.slice(6))) reject("Unknown local workflow task", 404);
    let record = read(`${id}.json`);
    if (!record) {
      const reservation = read(`request-${id.slice(6)}.json`);
      if (reservation?.protocol === "comfyui" && reservation.taskId === id) record = { ...reservation, state: "unconfirmed" };
    }
    if (!record || record.protocol !== "comfyui" || record.taskId !== id || !Object.hasOwn(types, record.type)) reject("Unknown local workflow task", 404);
    if (record.endpointHash !== connection().endpointHash) reject("Task belongs to a different local service", 409);
    return record;
  }
  function verifiedImport(entry, type) {
    const file = entry && asset(entry.assetName);
    if (!file || !types[type].includes(path.extname(file).slice(1)) || sha(fs.readFileSync(file)) !== entry.sha256) reject("Imported media changed or is missing", 409);
    return { assetUrl: `/api/media/assets/${entry.assetName}`, assetName: entry.assetName, type, sha256: entry.sha256 };
  }
  function view(record) {
    const terminal = record.terminal, state = terminal?.state ?? record.state ?? "unconfirmed";
    const imported = Object.values(record.imports ?? {})[0];
    return { taskId: record.taskId, type: record.type, state, isFinal: ["success", "failed"].includes(state), outputs: state === "success" ? terminal.outputs.map((output, index) => ({ index, name: output.filename })) : [], ...(imported ? { assetUrl: verifiedImport(imported, record.type).assetUrl } : {}) };
  }
  async function status(id, signal) {
    let record = task(id);
    if (!record.terminal && record.promptId) {
      const result = await connection().client.status(record.promptId, signal); signal?.throwIfAborted(); record = task(id);
      if (!record.terminal) {
        record = { ...record, state: result.state, ...(["success", "failed"].includes(result.state) ? { terminal: { state: result.state, outputs: result.outputs } } : {}) };
        save(`${id}.json`, record);
      }
    }
    return view(record);
  }
  async function importOutput(id, outputIndex, signal) {
    if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 4095) reject("Invalid output index");
    const key = `${id}:${outputIndex}`;
    if (pendingImports.has(key)) return pendingImports.get(key);
    const job = (async () => {
      let record = task(id), existing = record.imports?.[outputIndex];
      if (existing) return verifiedImport(existing, record.type);
      await status(id, signal); record = task(id);
      const output = record.terminal?.state === "success" && record.terminal.outputs[outputIndex];
      if (!output) reject("Select a completed workflow output", 409);
      const extension = path.extname(output.filename).slice(1).toLowerCase();
      if (!types[record.type].includes(extension)) reject("Output does not match the requested media type");
      const bytes = await connection().client.download(output, { signal, maxBytes: record.type === "image" ? 8 * 1024 * 1024 : 64 * 1024 * 1024 });
      signal?.throwIfAborted(); guard();
      if (!matches(bytes, extension)) reject("Workflow output type does not match its bytes", 422);
      const available = spawnSync("ffprobe", ["-version"], { timeout: 5000, windowsHide: true, stdio: "ignore" });
      if (available.error || available.status !== 0) reject("Media decoder is unavailable", 503);
      const digest = sha(bytes), name = `comfy-${digest}.${extension}`, temporary = path.join(root, `.comfy-import-${randomUUID()}.part`);
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        if (probe(temporary, record.type)) reject("Workflow output failed media decode", 422);
        signal?.throwIfAborted(); guard();
        if (!asset(name)) {
          try { writer.install(temporary, name); }
          catch (error) { if (!asset(name)) throw error; }
        }
        const entry = { assetName: name, sha256: digest }, receipt = verifiedImport(entry, record.type);
        record = task(id); existing = record.imports?.[outputIndex];
        if (existing) return verifiedImport(existing, record.type);
        save(`${id}.json`, { ...record, imports: { ...record.imports, [outputIndex]: entry } });
        return receipt;
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    })().finally(() => pendingImports.delete(key));
    pendingImports.set(key, job); return job;
  }
  return {
    setExecutionGuard(guard) { executionGuard = guard; },
    config, configure,
    async validate(input, signal) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["workflow", "inputs"].includes(key))) reject("Invalid node check input");
      return checkNodes(connection().client, prepared(input), signal);
    },
    configured() { try { connection(); return true; } catch { return false; } },
    findRequest(id) { if (!identifier(id)) return null; const record = read(`request-${id}.json`); if (record?.protocol !== "comfyui") return null; task(record.taskId); return { taskId: record.taskId }; },
    async submit(input, signal) {
      if (!input || Object.keys(input).some(key => !["requestId", "type", "workflow", "inputs", "confirmed", "bindingId", "quoteId"].includes(key)) || input.confirmed !== true || !identifier(input.requestId) || !Object.hasOwn(types, input.type)) reject("Invalid confirmed workflow request");
      const workflow = prepared(input), { client, endpointHash } = connection();
      const signature = sha(canonicalJson({ type: input.type, workflow, endpointHash, ...(input.bindingId ? { bindingId: input.bindingId, quoteId: input.quoteId } : {}) })), taskId = `comfy-${input.requestId}`, file = `request-${input.requestId}.json`;
      const previous = read(file);
      if (previous) {
        if (previous.protocol !== "comfyui" || previous.signature !== signature) reject("Request ID belongs to different input", 409);
        return { taskId: previous.taskId };
      }
      const checked = await checkNodes(client, workflow, signal);
      if (!checked.ok) throw Object.assign(new Error("Local workflow nodes are missing"), { status: 422, code: "missing-nodes", submitted: false, missing: checked.missing, checked: checked.checked });
      if (connection().endpointHash !== endpointHash) reject("Connection changed during node check", 409);
      if (executionGuard) await executionGuard(input, "comfyui");
      const record = { protocol: "comfyui", taskId, type: input.type, signature, endpointHash, createdAt: new Date().toISOString(), state: "unconfirmed" };
      signal?.throwIfAborted();
      try { save(file, record, true); }
      catch (error) { if (error.code !== "EEXIST") throw error; const other = read(file); if (other?.protocol !== "comfyui" || other.signature !== signature) reject("Request ID belongs to different input", 409); return { taskId: other.taskId }; }
      save(`${taskId}.json`, record, true);
      try { const promptId = await client.submit(workflow, [], signal); save(`${taskId}.json`, { ...record, promptId, state: "pending" }); }
      catch { return { taskId, state: "unconfirmed" }; }
      return { taskId };
    },
    status,
    async cancel(id, signal) { const record = task(id); const outcome = record.promptId && !record.terminal ? await connection().client.cancelQueued(record.promptId, signal) : "not-queued"; return { taskId: id, outcome }; },
    importOutput,
  };
}
