import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ComfyUIClient, prepareComfyWorkflow, type ComfyOutput } from "./comfyui";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const workflow = { "1": { class_type: "Text", inputs: { text: "Original", seed: 3, link: ["2", 0] } } };
const file: ComfyOutput = { nodeId: "1", filename: "result.png", subfolder: "batch/one", type: "output" };
const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
async function server(handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const instance = createServer(async (req, res) => { let body = ""; for await (const chunk of req) body += chunk; const parsed = body ? JSON.parse(body) : undefined; calls.push({ method: req.method!, path: req.url!, body: parsed }); handler(req, res, parsed); });
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }));
  return { client: new ComfyUIClient(`http://127.0.0.1:${(instance.address() as { port: number }).port}`), calls, endpoint: `http://127.0.0.1:${(instance.address() as { port: number }).port}` };
}
const history = (status = "success") => ({ p1: { status: { status_str: status, completed: true }, outputs: { "1": { images: [file] } } } });
it("submits one immutable mapped workflow, resumes by ID and downloads only same-origin view", async () => {
  const s = await server((req, res) => req.url === "/prompt" ? json(res, { prompt_id: "p1", node_errors: {} }) : req.url === "/history/p1" ? json(res, history()) : res.end("PNG"));
  expect(await s.client.submit(workflow, [{ nodeId: "1", input: "text", value: "Edited" }])).toBe("p1");
  expect(workflow["1"].inputs.text).toBe("Original"); expect(s.calls[0]!.body).toMatchObject({ prompt: { "1": { inputs: { text: "Edited" } } } });
  const resumed = new ComfyUIClient(s.endpoint); const result = await resumed.status("p1");
  expect(result).toEqual({ promptId: "p1", state: "success", outputs: [file] });
  expect((await resumed.download(result.outputs[0]!)).toString()).toBe("PNG");
  expect(s.calls.filter(c => c.method === "POST")).toHaveLength(1);
  expect(s.calls.at(-1)!.path).toBe("/view?filename=result.png&subfolder=batch%2Fone&type=output");
});
it("distinguishes pending, running, failed and missing history without submitting", async () => {
  let state = "pending";
  const s = await server((req, res) => req.url!.startsWith("/history") ? json(res, state === "failed" ? history("error") : {}) : json(res, { queue_pending: state === "pending" ? [[0, "p1"]] : [], queue_running: state === "running" ? [[0, "p1"]] : [] }));
  for (const expected of ["pending", "running", "failed", "unknown"]) { state = expected; expect((await s.client.status("p1")).state).toBe(expected); }
  expect(s.calls.every(c => c.method === "GET")).toBe(true);
});
it("rechecks history after a queue completion race", async () => {
  let reads = 0; const s = await server((req, res) => json(res, req.url!.startsWith("/history") ? ++reads === 1 ? {} : history() : { queue_running: [], queue_pending: [] }));
  expect((await s.client.status("p1")).state).toBe("success"); expect(reads).toBe(2);
});
it("deletes only the named queued prompt, never interrupts a running workflow", async () => {
  let running = false;
  const s = await server((req, res) => req.method === "POST" ? res.end() : json(res, { queue_running: running ? [[0, "p1"]] : [], queue_pending: [[1, "other"], ...running ? [] : [[2, "p1"]]] }));
  expect(await s.client.cancelQueued("p1")).toBe("delete-requested");
  running = true; expect(await s.client.cancelQueued("p1")).toBe("not-queued");
  expect(s.calls.filter(c => c.method === "POST")).toEqual([{ method: "POST", path: "/queue", body: { delete: ["p1"] } }]);
});
it("does not retry ambiguous submissions or HTTP errors", async () => {
  const s = await server((_req, res) => json(res, { error: "private server details" }, 503));
  await expect(s.client.submit(workflow)).rejects.toThrow("HTTP 503"); expect(s.calls).toHaveLength(1);
  const lost = await server((req, _res) => req.socket.destroy());
  await expect(lost.client.submit(workflow)).rejects.toThrow(); expect(lost.calls).toHaveLength(1);
});
it("rejects invalid scalar mappings and non-API workflows", () => {
  for (const patch of [{ nodeId: "missing", input: "text", value: "x" }, { nodeId: "1", input: "link", value: "x" }, { nodeId: "1", input: "seed", value: NaN }]) expect(() => prepareComfyWorkflow(workflow, [patch])).toThrow();
  expect(() => prepareComfyWorkflow({ nodes: [] })).toThrow();
  const patch = { nodeId: "1", input: "text", value: "x" }; expect(() => prepareComfyWorkflow(workflow, [patch, patch])).toThrow();
});
it.each(["https://remote.example", "http://2130706433", "http://localhost:8188", "http://192.168.1.1", "http://127.0.0.1/private", "http://user@127.0.0.1", "http://127.0.0.1/?x=1"])("rejects non-explicit origins %s", endpoint => { expect(() => new ComfyUIClient(endpoint)).toThrow("loopback"); });
it("rejects traversal, arbitrary result URLs and input folder before any HTTP request", async () => {
  const s = await server((_req, res) => res.end("bad"));
  for (const unsafe of [{ filename: "../file" }, { filename: "file%2fsecret" }, { filename: "C:secret" }, { subfolder: "../outside" }, { subfolder: "a\\b" }, { type: "input" }, { url: "https://remote.example/result" }]) await expect(s.client.download({ ...file, ...unsafe } as ComfyOutput)).rejects.toThrow();
  await expect(s.client.status("../p1")).rejects.toThrow(); expect(s.calls).toHaveLength(0);
});
it("bounds metadata and streaming bytes, rejects redirects and honors abort", async () => {
  let mode = "length";
  const s = await server((_req, res) => {
    if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/escape" }); res.end(); }
    else if (mode === "stream") { res.write("1234"); res.end("5678"); }
    else if (mode === "metadata") json(res, { text: "x".repeat(2 * 1024 * 1024) });
    else if (mode === "hang") res.write("1");
    else { res.writeHead(200, { "content-length": "8" }); res.end("12345678"); }
  });
  for (const kind of ["length", "stream"]) { mode = kind; await expect(s.client.download(file, { maxBytes: 4 })).rejects.toThrow("byte limit"); }
  mode = "metadata"; await expect(s.client.status("p1")).rejects.toThrow("byte limit");
  mode = "redirect"; await expect(s.client.download(file)).rejects.toThrow();
  mode = "hang"; const controller = new AbortController(); const pending = s.client.download(file, { signal: controller.signal }); const timer = setTimeout(() => controller.abort(), 20);
  try { await expect(pending).rejects.toThrow(); } finally { clearTimeout(timer); }
  expect(s.calls.every(c => !c.path.includes("escape"))).toBe(true);
});
it("rejects malformed history and unsafe descriptors returned by history", async () => {
  const data = history(); data.p1.outputs["1"].images[0] = { ...file, subfolder: "../escape" };
  const s = await server((_req, res) => json(res, data)); await expect(s.client.status("p1")).rejects.toThrow("Unsafe");
});
it("checks unique node classes with bounded concurrency and never executes a workflow", async () => {
  let active = 0, peak = 0;
  const s = await server((req, res) => {
    active++; peak = Math.max(peak, active);
    const name = decodeURIComponent(req.url!.slice("/object_info/".length));
    setTimeout(() => { active--; json(res, name === "Missing" ? {} : { [name]: { name, input: {}, output: ["IMAGE"] } }); }, 5);
  });
  const input = Object.fromEntries(["A", "A", "B", "C", "D", "E", "Space / 名称", "Missing"].map((name, i) => [String(i), { class_type: name, inputs: {} }]));
  expect(await s.client.checkNodes(input)).toEqual({ ok: false, checked: 7, available: ["A", "B", "C", "D", "E", "Space / 名称"], missing: ["Missing"] });
  expect(peak).toBeLessThanOrEqual(4); expect(peak).toBeGreaterThan(1);
  expect(s.calls).toHaveLength(7); expect(s.calls.every(call => call.method === "GET" && call.path.startsWith("/object_info/"))).toBe(true);
  expect(s.calls.some(call => call.path.includes("Space%20%2F%20%E5%90%8D%E7%A7%B0"))).toBe(true);
});
it("rejects malformed node metadata instead of claiming nodes are available", async () => {
  let metadata: unknown = { Text: {} };
  const s = await server((_req, res) => json(res, metadata));
  for (const bad of [{ Text: {} }, { wrong: { name: "wrong", input: {}, output: [] } }, { Text: { name: "Other", input: {}, output: [] } }, { error: "unknown" }, []]) {
    metadata = bad; await expect(s.client.checkNodes(workflow)).rejects.toThrow();
  }
  metadata = { Text: { name: "Text", input: {}, output: [] } };
  expect(await s.client.checkNodes(workflow)).toEqual({ ok: true, checked: 1, available: ["Text"], missing: [] });
});
it("bounds node check size before networking and aborts the entire batch", async () => {
  const s = await server((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), { class_type: `Node${i}`, inputs: {} }]));
  await expect(s.client.checkNodes(many)).rejects.toThrow("class limits");
  await expect(s.client.checkNodes({ one: { class_type: "..", inputs: {} } })).rejects.toThrow("class limits");
  expect(s.calls).toHaveLength(0);
  const controller = new AbortController(), pending = s.client.checkNodes(workflow, controller.signal);
  const timer = setTimeout(() => controller.abort(), 20);
  try { await expect(pending).rejects.toThrow(); } finally { clearTimeout(timer); }
  expect(s.calls).toHaveLength(1);
});
