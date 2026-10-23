import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Copies the built package outside the repository and runs the real workflow
 * there. Guards against absolute paths leaking from this checkout.
 */
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const lite = process.argv.includes("--lite");
const source = path.join(root, "dist-portable", lite ? "Glint-lite" : "Glint");
if (!existsSync(path.join(source, "Glint.exe"))) throw new Error("Build the package first: pnpm desktop:package");
const temp = mkdtempSync(path.join(os.tmpdir(), "glint-standalone-"));
const out = path.join(temp, "Glint");
cpSync(source, out, { recursive: true });

const app = path.join(out, "app");
const node = lite ? process.execPath : path.join(out, "node.exe");
const env = {
  ...process.env,
  GLINT_DESKTOP_REPO: app,
  GLINT_DESKTOP_NODE: node,
  GLINT_DESKTOP_SERVICE: path.join(app, "server", "service.mjs"),
  GLINT_WEB_DIST: path.join(app, "web"),
  GLINT_STUDIO_DIR: path.join(app, "studio"),
  GLINT_MAKE_ENTRY: path.join(app, "cli", "glint.mjs"),
  GLINT_MAKE_NODE: node,
  GLINT_CLI_ENTRY: path.join(app, "cli", "glint.mjs"),
  GLINT_BUILD_ID: "standalone-check",
  GLINT_JOB_DEBUG: "1",
};
const dataDir = path.join(temp, "data");
mkdirSync(dataDir, { recursive: true });
const nonce = "standalone-check-0123456789abcdef";

try {
  const service = spawn(node, [path.join(app, "server", "service.mjs"), `--data-dir=${dataDir}`, `--nonce=${nonce}`],
    { cwd: app, env, stdio: ["pipe", "pipe", "pipe"] });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { service.kill(); reject(new Error("Standalone service did not become ready")); }, 30_000);
    let buffer = "";
    service.stdout.on("data", chunk => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find(value => value.includes(`"nonce":"${nonce}"`));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(line.indexOf("{")))); }
    });
    service.stderr.on("data", chunk => { buffer += String(chunk); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Standalone service exited early (${code}): ${buffer.slice(-400)}`)); });
  });
  if (!(await fetch(`${ready.url}/healthz`)).ok) throw new Error("Standalone health check failed");
  const submitted = await (await fetch(`${ready.url}/api/make`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "第一节：在仓库外运行。第二节：仍然能渲染成片并取回工程。", tts: "mock", music: "off", encoding: "draft" }) })).json();
  if (!submitted?.jobId) throw new Error(`Standalone submission rejected: ${JSON.stringify(submitted).slice(0, 200)}`);
  let job = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(done => setTimeout(done, 2000));
    job = await (await fetch(`${ready.url}/api/make/${submitted.jobId}`)).json();
    if (["done", "failed", "cancelled"].includes(job.status)) break;
  }
  if (job?.status !== "done") throw new Error(`Standalone render failed: ${JSON.stringify(job).slice(0, 300)}`);
  const composed = await (await fetch(`${ready.url}/api/make/${submitted.jobId}/project`)).json();
  service.stdin.write(JSON.stringify({ type: "shutdown", nonce }) + "\n");
  service.stdin.end();
  console.log(JSON.stringify({ standalone: "ok", copiedTo: out, render: job.status, scenes: composed.project.scenes.length }, null, 2));
} finally {
  for (let attempt = 0; attempt < 20 && existsSync(temp); attempt++) {
    try { rmSync(temp, { recursive: true, force: true }); } catch { await new Promise(done => setTimeout(done, 250)); }
  }
}
