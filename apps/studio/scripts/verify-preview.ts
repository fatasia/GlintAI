import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createCliRuntime } from "./glint-runtime";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-preview-check-")),
  root = path.join(out, "repo");
fs.mkdirSync(root);
const server = net.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => server.close(() => resolve()));
const target = path.join(root, "index.mjs");
fs.writeFileSync(
  target,
  `import http from 'node:http';http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Code preview fixture</h1>')}).listen(${port},'127.0.0.1');`,
);
const config = path.join(out, "preview.json"),
  context = path.join(out, "context.json");
fs.writeFileSync(
  config,
  JSON.stringify({
    command: process.execPath,
    args: [target],
    url: `http://127.0.0.1:${port}`,
    ttlMs: 60_000,
  }),
);
const runtime = createCliRuntime(new URL("./glint.ts", import.meta.url).href),
  child = spawn(
    process.execPath,
    runtime.scriptArgs("preview-code", [
      `--code=${root}`,
      `--preview-config=${config}`,
      `--out=${context}`,
    ]),
    {
      cwd: runtime.studioDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
let stdout = "";
const timer = setTimeout(() => child.kill(), 90_000);
try {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      reject(new Error(`Early exit ${code}: ${stderr}`)),
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve();
    });
  });
  const ready = JSON.parse(stdout.trim());
  assert.equal(ready.status, "ready");
  assert(
    (await (await fetch(ready.url)).text()).includes("Code preview fixture"),
  );
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  child.stdin.end("stop\n");
  assert.equal(await closed, 0);
  assert.equal(JSON.parse(fs.readFileSync(context, "utf8")).status, "stopped");
  let live = false;
  try {
    await fetch(ready.url);
    live = true;
  } catch {}
  assert(!live, "Preview process tree must stop");
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify({ status: "passed", context, ready }, null, 2),
  );
  console.log(
    `[preview] actual startup, loopback readiness, code graph and process-tree shutdown: ${out}`,
  );
} finally {
  clearTimeout(timer);
  child.kill();
}
