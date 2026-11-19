import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMediaJobs } from "./media-jobs.mjs";

let root: string, upstream: Server, endpoint: string, submits: number, historyReads: number, views: number, deleted: string[], mode: string, bytes: Buffer, nodeMode: string, nodeChecks: number;
const workflow = { "1": { class_type: "Fixture", inputs: { text: "private-workflow-value" } } };
const input = { requestId: "request1", type: "image", workflow, inputs: [], confirmed: true };
const roots: string[] = [];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-media-")); roots.push(root); submits = historyReads = views = nodeChecks = 0; deleted = []; mode = "pending"; nodeMode = "ready";
  const fixture = path.join(root, "fixture.png"); execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=16x16", "-frames:v", "1", fixture], { windowsHide: true }); bytes = fs.readFileSync(fixture); fs.unlinkSync(fixture);
  upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url === "/object_info/Fixture") {
      nodeChecks++;
      if (nodeMode === "hang") { res.writeHead(200); res.write("{"); return; }
      res.end(JSON.stringify(nodeMode === "missing" ? {} : { Fixture: nodeMode === "invalid" ? {} : { name: "Fixture", input: {}, output: [] } })); return;
    }
    if (req.url === "/prompt") { submits++; if (mode === "disconnect") { req.socket.destroy(); return; } res.end(JSON.stringify({ prompt_id: "prompt1" })); return; }
    if (req.url?.startsWith("/history/")) { historyReads++; res.end(JSON.stringify(mode === "success" || mode === "failed" ? { prompt1: { status: { completed: true, status_str: mode === "failed" ? "error" : "success" }, outputs: { "1": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } } } : {})); return; }
    if (req.url === "/queue" && req.method === "POST") { deleted.push(...JSON.parse(raw).delete); res.end("{}"); return; }
    if (req.url === "/queue") { res.end(JSON.stringify({ queue_pending: mode === "pending" ? [[1, "prompt1"]] : [], queue_running: mode === "running" ? [[1, "prompt1"]] : [] })); return; }
    if (req.url?.startsWith("/view?")) { views++; res.end(bytes); return; } res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); endpoint = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterEach(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const jobs = () => createMediaJobs(root, { GLINT_COMFYUI_ENDPOINT: endpoint });
it("shares request reservations across instances, stores only hashes, resumes and pins terminal outputs", async () => {
  const a = jobs(), b = jobs(); const [one, two] = await Promise.all([a.comfyui.submit(input), b.comfyui.submit(input)]);
  expect(one.taskId).toBe(two.taskId); expect(submits).toBe(1); expect(a.findRequest(input.requestId)).toEqual({ taskId: one.taskId });
  await expect(b.comfyui.submit({ ...input, type: "video" })).rejects.toMatchObject({ status: 409 });
  for (const file of fs.readdirSync(root)) expect(fs.readFileSync(path.join(root, file), "utf8")).not.toContain("private-workflow-value");
  expect((await b.comfyui.status(one.taskId)).state).toBe("pending"); mode = "success";
  expect((await jobs().status(one.taskId)).outputs).toEqual([{ index: 0, name: "result.png" }]); expect(views).toBe(0); expect(a.library()).toEqual([]);
  const reads = historyReads; mode = "unknown"; expect((await jobs().comfyui.status(one.taskId)).state).toBe("success"); expect(historyReads).toBe(reads);
  const receipt = await b.comfyui.importOutput(one.taskId, 0); expect(receipt.type).toBe("image"); expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(a.library().map((asset: { name: string }) => asset.name)).toEqual([receipt.assetName]);
  expect(await jobs().comfyui.importOutput(one.taskId, 0)).toEqual(receipt); expect(views).toBe(1);
  fs.writeFileSync(a.asset(receipt.assetName), "tampered"); await expect(b.comfyui.importOutput(one.taskId, 0)).rejects.toMatchObject({ status: 409 });
});
it("preserves ambiguous submissions without reposting and rejects legacy request collisions", async () => {
  mode = "disconnect"; const a = jobs(), receipt = await a.comfyui.submit(input); expect(receipt.state).toBe("unconfirmed");
  expect((await jobs().comfyui.submit(input)).taskId).toBe(receipt.taskId); expect(submits).toBe(1);
  expect((await jobs().comfyui.status(receipt.taskId)).state).toBe("unconfirmed");
  fs.writeFileSync(path.join(root, "request-legacy.json"), JSON.stringify({ signature: "other", taskId: "gateway" }));
  await expect(a.comfyui.submit({ ...input, requestId: "legacy" })).rejects.toMatchObject({ status: 409 }); expect(submits).toBe(1);
});
it("cancels only the queued prompt, reports unknown and failed without invented success", async () => {
  const a = jobs(), { taskId } = await a.comfyui.submit(input);
  expect(await a.cancel(taskId)).toEqual({ taskId, outcome: "delete-requested" }); expect(deleted).toEqual(["prompt1"]);
  mode = "running"; expect((await a.comfyui.cancel(taskId)).outcome).toBe("not-queued");
  mode = "unknown"; expect((await a.comfyui.status(taskId)).state).toBe("unknown");
  mode = "failed"; expect((await a.comfyui.status(taskId)).state).toBe("failed");
  mode = "success"; expect((await a.comfyui.status(taskId)).state).toBe("failed");
  await expect(a.comfyui.importOutput(taskId, 0)).rejects.toMatchObject({ status: 409 }); expect(views).toBe(0);
});
it("refuses malformed input, endpoint changes and bad decoded bytes with no published asset", async () => {
  const a = jobs();
  await expect(a.comfyui.submit({ ...input, endpoint })).rejects.toThrow();
  await expect(a.comfyui.submit({ ...input, confirmed: false })).rejects.toThrow();
  await expect(a.comfyui.submit(JSON.parse(JSON.stringify(input).replace('"text":', '"__proto__":')))).rejects.toThrow(); expect(submits).toBe(0);
  const { taskId } = await a.comfyui.submit(input); mode = "success"; bytes = Buffer.from("not png");
  await expect(a.comfyui.importOutput(taskId, 0)).rejects.toMatchObject({ status: 422 }); expect(a.library()).toEqual([]); expect(fs.readdirSync(root).filter(name => name.endsWith(".part"))).toEqual([]);
  a.applyEnv({ GLINT_COMFYUI_ENDPOINT: "http://127.0.0.1:1" }); await expect(a.comfyui.status(taskId)).rejects.toMatchObject({ status: 409 });
});
it("refuses symlink records and a swapped library root", async () => {
  const a = jobs(), target = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-foreign-")); roots.push(target);
  fs.symlinkSync(target, path.join(root, "request-link.json"), "junction");
  await expect(a.comfyui.submit({ ...input, requestId: "link" })).rejects.toMatchObject({ status: 409 }); expect(submits).toBe(0);
  const moved = root + "-original"; fs.renameSync(root, moved); roots.push(moved); fs.symlinkSync(target, root, "junction");
  await expect(a.comfyui.submit(input)).rejects.toMatchObject({ status: 409 }); expect(fs.readdirSync(target)).toEqual([]);
});
it("requires a decoder and honors abort without publishing bytes or resubmitting", async () => {
  const a = jobs(), { taskId } = await a.comfyui.submit(input); mode = "success"; await a.comfyui.status(taskId);
  const previous = process.env.PATH;
  try { process.env.PATH = root; await expect(a.comfyui.importOutput(taskId, 0)).rejects.toMatchObject({ status: 503 }); }
  finally { process.env.PATH = previous; }
  expect(a.library()).toEqual([]); expect(fs.readdirSync(root).filter(name => name.endsWith(".part"))).toEqual([]);
  const controller = new AbortController(); controller.abort();
  await expect(a.comfyui.importOutput(taskId, 0, controller.signal)).rejects.toThrow();
  expect(a.library()).toEqual([]);
  const before = fs.readdirSync(root);
  await expect(a.comfyui.submit({ ...input, requestId: "cancel-before" }, controller.signal)).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual(before); expect(submits).toBe(1);
});
it("persists a connection without creating settings on read, then clears back to environment", async () => {
  const a = jobs(), file = path.join(root, "comfyui-settings.json");
  expect(a.comfyui.config()).toEqual({ configured: true, endpoint, source: "environment" }); expect(fs.existsSync(file)).toBe(false);
  expect(a.comfyui.configure({ endpoint: endpoint + "/" })).toEqual({ configured: true, endpoint, source: "saved" });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ endpoint });
  expect(jobs().comfyui.config().source).toBe("saved");
  expect(a.comfyui.configure({ endpoint: null })).toEqual({ configured: true, endpoint, source: "environment" }); expect(fs.existsSync(file)).toBe(false);
  a.applyEnv({ GLINT_COMFYUI_ENDPOINT: "https://user:secret@remote.test" });
  expect(a.comfyui.config()).toEqual({ configured: false, endpoint: null, source: "environment" });
});
it("refuses public or malformed settings and does not overwrite corrupt saved JSON", () => {
  const a = jobs(), file = path.join(root, "comfyui-settings.json");
  for (const value of ["http://localhost:8188", "http://remote.test", "http://127.0.0.1/a", "http://u:p@127.0.0.1", "http://127.0.0.1?x=y", "http://127.0.0.1#x"]) expect(() => a.comfyui.configure({ endpoint: value })).toThrow();
  for (const value of [{ endpoint, token: "no" }, {}, [], JSON.parse('{"endpoint":null,"__proto__":{}}')]) expect(() => a.comfyui.configure(value)).toThrow();
  expect(fs.existsSync(file)).toBe(false);
  for (const raw of ["{", "null", '{"endpoint":"http://remote.test"}', '{"endpoint":"http://127.0.0.1","constructor":{}}', "x".repeat(1025)]) {
    fs.writeFileSync(file, raw); expect(() => a.comfyui.config()).toThrow(); expect(() => a.comfyui.configure({ endpoint })).toThrow(); expect(fs.readFileSync(file, "utf8")).toBe(raw);
  }
});
it("pins tasks to their service, resumes after restoring it, and rejects settings symlinks/root swaps", async () => {
  const a = jobs(), { taskId } = await a.comfyui.submit(input);
  a.comfyui.configure({ endpoint: "http://127.0.0.1:1" }); await expect(jobs().comfyui.status(taskId)).rejects.toMatchObject({ status: 409 }); expect(submits).toBe(1);
  a.comfyui.configure({ endpoint }); expect((await jobs().comfyui.status(taskId)).state).toBe("pending"); expect(submits).toBe(1);
  a.comfyui.configure({ endpoint: null });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-settings-foreign-")); roots.push(target);
  fs.symlinkSync(target, path.join(root, "comfyui-settings.json"), "junction");
  expect(() => a.comfyui.config()).toThrow(); expect(() => a.comfyui.configure({ endpoint })).toThrow(); expect(fs.readdirSync(target)).toEqual([]);
  const moved = root + "-original"; fs.renameSync(root, moved); roots.push(moved); fs.symlinkSync(target, root, "junction");
  expect(() => a.comfyui.config()).toThrow(); expect(() => a.comfyui.configure({ endpoint })).toThrow(); expect(fs.readdirSync(target)).toEqual([]);
});
it("validates without tasks and refuses missing nodes before reserving or submitting", async () => {
  const a = jobs(); nodeMode = "missing";
  expect(await a.comfyui.validate({ workflow })).toEqual({ ok: false, checked: 1, available: [], missing: ["Fixture"], submitted: false });
  await expect(a.comfyui.submit(input)).rejects.toMatchObject({ status: 422, code: "missing-nodes", submitted: false, missing: ["Fixture"] });
  expect(submits).toBe(0); expect(fs.readdirSync(root)).toEqual([]);
  nodeMode = "ready";
  expect(await a.comfyui.validate({ workflow, inputs: [] })).toEqual({ ok: true, checked: 1, available: ["Fixture"], missing: [], submitted: false });
  expect(submits).toBe(0); expect(fs.readdirSync(root)).toEqual([]);
  const receipt = await a.comfyui.submit(input); expect(submits).toBe(1); const checks = nodeChecks;
  nodeMode = "invalid"; expect(await jobs().comfyui.submit(input)).toEqual(receipt); expect(nodeChecks).toBe(checks); expect(submits).toBe(1);
});
it("fails closed on malformed node metadata or timed-out checks without writing a request", async () => {
  const a = jobs(); nodeMode = "invalid";
  await expect(a.comfyui.submit(input)).rejects.toMatchObject({ code: "node-check-failed", submitted: false });
  nodeMode = "hang";
  await expect(a.comfyui.submit(input, AbortSignal.timeout(30))).rejects.toMatchObject({ code: "node-check-failed", submitted: false });
  expect(submits).toBe(0); expect(fs.readdirSync(root)).toEqual([]);
  await expect(a.comfyui.validate({ workflow, endpoint })).rejects.toThrow(); expect(nodeChecks).toBe(2);
});
