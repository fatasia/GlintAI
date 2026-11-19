import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runComfyUI } from "./comfyui-cli";
let root: string, server: Server | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-cli-")); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } fs.rmSync(root, { recursive: true, force: true }); });
const workflow = { "1": { class_type: "Text", inputs: { text: "Original" } } };
const file = (name: string, value: unknown) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
async function run(args: string[]) { const lines: string[] = []; const code = await runComfyUI(args, line => lines.push(line)); return { code, value: JSON.parse(lines[0]!) }; }
async function start() {
  const calls: Array<{ method: string; url: string; body: unknown }> = []; let completed = true, drop = false, unsafe = false, missingNode = false;
  server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    calls.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined });
    res.setHeader("content-type", "application/json");
    if (req.url === "/prompt") { if (drop) req.socket.destroy(); else res.end(JSON.stringify({ prompt_id: "p1" })); }
    else if (req.url!.startsWith("/object_info/")) { const name = decodeURIComponent(req.url!.slice("/object_info/".length)); res.end(JSON.stringify(missingNode ? {} : { [name]: { name, input: {}, output: [] } })); }
    else if (req.url === "/queue") res.end(req.method === "POST" ? "" : JSON.stringify({ queue_pending: [[1, "p1"], [2, "other"]], queue_running: [] }));
    else if (req.url!.startsWith("/history/")) res.end(JSON.stringify(completed ? { p1: { status: { completed: true, status_str: "success" }, outputs: { "1": { images: [{ filename: unsafe ? "../escape.png" : "image.png", subfolder: "", type: "output" }] } } } } : {}));
    else if (req.url!.startsWith("/view?")) res.end("PNG fixture");
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return { endpoint, calls, setMissingNode: (value: boolean) => { missingNode = value; }, setCompleted: (value: boolean) => { completed = value; }, setDrop: () => { drop = true; }, setUnsafe: () => { unsafe = true; } };
}
it("rejects missing, unknown, duplicate or action-incompatible arguments and absent confirmation before HTTP", async () => {
  const s = await start(), endpoint = `--endpoint=${s.endpoint}`, input = `--workflow=${file("workflow.json", workflow)}`;
  for (const args of [["submit", endpoint, input], ["status", "--id=p1"], ["status", endpoint], ["submit", endpoint, input, "--confirm-execute=false"], ["submit", endpoint, input, "--confirm-execute", "--confirm-execute"], ["status", endpoint, "--id=p1", "--url=http://elsewhere"], ["status", endpoint, "--id=p1", "--workflow=x"], ["download", endpoint, "--id=p1", "--out=x", "--output-index=-1"]]) expect((await run(args)).code).toBe(2);
  expect(s.calls).toHaveLength(0);
});
it("validates bounded regular files and mapping types before submission", async () => {
  const s = await start(), base = ["submit", `--endpoint=${s.endpoint}`, "--confirm-execute"];
  for (const input of [root, file("big.json", "x".repeat(2 * 1024 * 1024)), file("invalid.json", { nodes: [] })]) expect((await run([...base, `--workflow=${input}`])).code).toBe(2);
  const input = file("workflow.json", workflow);
  for (const mapping of [{}, [{ nodeId: "1", input: "text", value: [], extra: "bad" }], [{ nodeId: "1", input: "text", value: 2 }]]) expect((await run([...base, `--workflow=${input}`, `--inputs=${file("mapping.json", mapping)}`])).code).toBe(2);
  expect(s.calls).toHaveLength(0);
});
it("submits once on confirmation and marks a lost response unconfirmed without resubmitting", async () => {
  const s = await start(), input = file("workflow.json", workflow), mapping = file("mapping.json", [{ nodeId: "1", input: "text", value: "Mapped" }]);
  const args = ["submit", `--endpoint=${s.endpoint}`, `--workflow=${input}`, `--inputs=${mapping}`, "--confirm-execute"];
  expect(await run(args)).toEqual({ code: 0, value: { promptId: "p1", submitted: true } });
  expect(s.calls[0]!.body).toEqual({ prompt: { "1": { class_type: "Text", inputs: { text: "Mapped" } } } });
  expect(JSON.parse(fs.readFileSync(input, "utf8"))).toEqual(workflow);
  s.setDrop(); expect(await run(args)).toMatchObject({ code: 2, value: { error: "submission-unconfirmed", retryAutomatically: false } });
  expect(s.calls.filter(c => c.url === "/prompt")).toHaveLength(2);
});
it("recovers existing IDs, deletes only the queued ID, and exclusively downloads selected history output", async () => {
  const s = await start(), args = [`--endpoint=${s.endpoint}`, "--id=p1"], destination = path.join(root, "result.png");
  expect(await run(["status", ...args])).toMatchObject({ code: 0, value: { promptId: "p1", state: "success" } });
  expect(await run(["cancel", ...args])).toEqual({ code: 0, value: { promptId: "p1", cancellation: "delete-requested" } });
  expect(s.calls.find(c => c.method === "POST")!.body).toEqual({ delete: ["p1"] });
  expect((await run(["download", ...args, "--output-index=0", `--out=${destination}`])).code).toBe(0);
  expect(fs.readFileSync(destination, "utf8")).toBe("PNG fixture");
  fs.writeFileSync(destination, "Keep original");
  expect(await run(["download", ...args, "--output-index=0", `--out=${destination}`])).toEqual({ code: 2, value: { error: "output-exists" } });
  expect(fs.readFileSync(destination, "utf8")).toBe("Keep original");
  for (const extra of [["--output-index=2"], ["--output-index=0", "--max-bytes=2"]]) expect((await run(["download", ...args, ...extra, `--out=${path.join(root, "never.png")}`])).code).toBe(2);
  s.setCompleted(false); expect((await run(["download", ...args, "--output-index=0", `--out=${destination}`])).value.error).toBe("prompt-not-successful");
  s.setCompleted(true); s.setUnsafe(); expect((await run(["download", ...args, "--output-index=0", `--out=${destination}`])).code).toBe(2);
  expect(fs.existsSync(path.join(root, "never.png"))).toBe(false); expect(s.calls.some(c => c.url === "/prompt" || c.url === "/interrupt")).toBe(false);
});
it("executes the real lazy CLI route with JSON output and nonzero failures", async () => {
  const s = await start(), repo = path.resolve(import.meta.dirname, "../../.."), loader = createRequire(path.join(repo, "apps/studio/package.json")).resolve("tsx");
  const cli = (args: string[], throughSkill = false) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const command = throughSkill ? [path.join(repo, "skills/glint-video/scripts/glint.mjs"), `--root=${repo}`, "comfyui", ...args] : ["--import", pathToFileURL(loader).href, path.join(repo, "apps/studio/scripts/glint.ts"), "comfyui", ...args];
    const child = spawn(process.execPath, command, { cwd: root, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk); child.once("error", reject); child.once("close", code => resolve({ code, out, err }));
  });
  file("workflow.json", workflow);
  const submitted = await cli(["submit", `--endpoint=${s.endpoint}`, "--workflow=workflow.json", "--confirm-execute"], true);
  expect(submitted.code).toBe(0); expect(submitted.err).toBe(""); expect(JSON.parse(submitted.out).promptId).toBe("p1");
  const status = await cli(["status", `--endpoint=${s.endpoint}`, "--id=p1"]); expect(status.code).toBe(0); expect(JSON.parse(status.out).state).toBe("success");
  const cancelled = await cli(["cancel", `--endpoint=${s.endpoint}`, "--id=p1"]); expect(cancelled.code).toBe(0); expect(JSON.parse(cancelled.out).cancellation).toBe("delete-requested");
  const destination = path.join(root, "cli-result.png"), downloaded = await cli(["download", `--endpoint=${s.endpoint}`, "--id=p1", "--output-index=0", "--out=cli-result.png"], true);
  expect(downloaded.code).toBe(0); expect(JSON.parse(downloaded.out).bytes).toBe(11); expect(fs.readFileSync(destination, "utf8")).toBe("PNG fixture");
  const checked = await cli(["check", `--endpoint=${s.endpoint}`, "--workflow=workflow.json"], true);
  expect(checked.code).toBe(0); expect(JSON.parse(checked.out)).toEqual({ ok: true, checked: 1, available: ["Text"], missing: [] });
  s.setMissingNode(true);
  const missing = await cli(["check", `--endpoint=${s.endpoint}`, "--workflow=workflow.json"], true);
  expect(missing.code).toBe(2); expect(JSON.parse(missing.out)).toEqual({ ok: false, checked: 1, available: [], missing: ["Text"] });
  const denied = await cli(["submit", `--endpoint=${s.endpoint}`]); expect(denied.code).toBe(2); expect(JSON.parse(denied.out).error).toBe("confirmation-required");
  expect(s.calls.filter(c => c.url === "/prompt")).toHaveLength(1);
}, 30000);

it("check rejects execution/mapping flags and missing workflow without submitting", async () => {
  const s = await start();
  for (const extra of [[], ["--confirm-execute"], ["--inputs=mapping.json"], ["--id=p1"]]) {
    expect((await run(["check", `--endpoint=${s.endpoint}`, ...extra])).code).toBe(2);
  }
  expect(s.calls).toHaveLength(0);
});
