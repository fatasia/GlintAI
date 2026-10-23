import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { createConnection } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startDesktopService } from "./desktop-service.mjs";
import { createJobRunner } from "./jobs.mjs";

const directories: string[] = [];
const services: { close: () => Promise<void> }[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const entry = fileURLToPath(new URL("./desktop-service.mjs", import.meta.url));
const loader = pathToFileURL(createRequire(new URL("../package.json", import.meta.url)).resolve("tsx")).href;
const nonce = "random-boot-token-0123456789abcdef";
const project = { schemaVersion: 1, id: "desktop-project", title: "桌面😀", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "scene-1", kind: "title", title: "Title", narration: { text: "Narration" } }] };
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "glint-desktop-")); directories.push(value); return value;
}
async function start(options = {}) {
  const service = await startDesktopService({ dataDir: directory(), ...options }); services.push(service); return service;
}
function post(url: string, body: unknown) { return fetch(url, { method: "POST", body: JSON.stringify(body) }); }
function child(args: string[], cwd = directory()) {
  const process = spawn(globalThis.process.execPath, ["--import", loader, entry, ...args], {
    cwd, shell: false, windowsHide: true, stdio: "pipe",
    env: { ...globalThis.process.env, GLINT_PUBLIC_HOST: "remote.example", GLINT_HOST: "0.0.0.0", PORT: "4175", GLINT_ACCESS_TOKEN: "SECRET-HTTP-CREDENTIAL-DO-NOT-PRINT", GLINT_LLM_API_KEY: "SECRET-API-DO-NOT-PRINT" },
  });
  children.push(process);
  let stdout = "", stderr = "";
  process.stdout.setEncoding("utf8"); process.stderr.setEncoding("utf8");
  process.stdout.on("data", chunk => { stdout += chunk; }); process.stderr.on("data", chunk => { stderr += chunk; });
  const closed = once(process, "close");
  const ready = new Promise<{ type: string; url: string; nonce: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No desktop ready record")), 15000);
    const data = () => {
      if (!stdout.includes("\n")) return;
      clearTimeout(timer); process.stdout.off("data", data);
      try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); }
    };
    process.stdout.on("data", data);
    void closed.then(() => { clearTimeout(timer); if (!stdout.includes("\n")) reject(new Error("Child exited before readiness")); });
  });
  void ready.catch(() => {});
  return { process, ready, closed, output: () => ({ stdout, stderr }) };
}
beforeEach(() => {
  for (const name of ["GLINT_DATA_DIR", "GLINT_CACHE_DIR", "GLINT_SESSION_DIR"]) vi.stubEnv(name, process.env[name]);
});
afterEach(async () => {
  for (const process of children.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) {
      const closed = once(process, "close"); process.kill(); await closed;
    }
  }
  for (const service of services.splice(0)) await service.close().catch(() => {});
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("serves real health, static files, composition and rejects nonlocal Host/cross-origin mutations", async () => {
  vi.stubEnv("GLINT_PUBLIC_HOST", "attacker.example");
  vi.stubEnv("GLINT_HOST", "0.0.0.0");
  const distDir = directory(); fs.writeFileSync(path.join(distDir, "index.html"), "<h1>Desktop</h1>");
  const service = await start({ distDir });
  expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  expect(service.instanceToken).toMatch(/^[a-f0-9]{64}$/);
  const health = await (await fetch(`${service.url}/api/health`)).json();
  expect(health).toMatchObject({ status: "ok", service: "glint-web" });
  expect(JSON.stringify(health)).not.toContain(service.instanceToken);
  expect(await (await fetch(service.url)).text()).toBe("<h1>Desktop</h1>");
  const composed = await post(`${service.url}/api/compose`, { source: "# Desktop\n\n## Facts\nEvidence stays local.", template: "explainer" });
  expect(composed.status).toBe(200); expect((await composed.json()).project.scenes.length).toBeGreaterThan(1);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${service.url}/api/health`, { headers: { host: "attacker.example" } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end();
  });
  expect(status).toBe(403);
  expect((await fetch(`${service.url}/api/session/open`, { method: "POST", headers: { origin: "https://attacker.example" }, body: "{}" })).status).toBe(403);
});

it("isolates every persistence store and recovers checks, jobs, assets and sessions on restart", async () => {
  const dataDir = directory(), otherDir = directory(), studioDir = directory();
  const job = { id: "idea-recovered", status: "failed", stage: "failed", createdAt: Date.now(), finishedAt: Date.now(), log: ["failed"], requestId: "request-recovered" };
  fs.mkdirSync(path.join(dataDir, "jobs", ".jobs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "jobs", ".jobs", `${job.id}.json`), JSON.stringify(job));
  const a = await start({ dataDir, studioDir });
  const b = await start({ dataDir: otherDir, studioDir });
  expect(a.instanceToken).not.toBe(b.instanceToken);
  expect((await post(`${a.url}/api/session/open`, { projectId: project.id, project })).status).toBe(200);
  const answers = { attemptId: "desktop-attempt-123", answers: [{ id: "isolated", choice: 1 }, { id: "life", choice: 1 }] };
  expect((await post(`${a.url}/api/checks/entropy`, answers)).status).toBe(200);
  fs.writeFileSync(path.join(dataDir, "media", "local.png"), Buffer.from("local asset"));
  expect(await (await fetch(`${a.url}/api/media/assets/local.png`)).text()).toBe("local asset");
  expect((await (await fetch(`${b.url}/api/session/list`)).json()).projects).toEqual([]);
  expect((await (await fetch(`${b.url}/api/checks/entropy/stats`)).json()).attempts).toBe(0);
  expect((await fetch(`${b.url}/api/make/${job.id}`)).status).toBe(404);
  expect((await (await fetch(`${b.url}/api/media/library`)).json()).assets).toEqual([]);
  await a.close();
  const recovered = await start({ dataDir, studioDir });
  expect((await (await fetch(`${recovered.url}/api/session/snapshot?projectId=${project.id}`)).json()).snapshot.document.title).toBe(project.title);
  expect((await (await fetch(`${recovered.url}/api/checks/entropy/stats`)).json()).attempts).toBe(1);
  expect((await (await fetch(`${recovered.url}/api/make/request/request-recovered`)).json()).id).toBe(job.id);
  expect(fs.readdirSync(dataDir).sort()).toEqual(["checks", "jobs", "media", "sessions"]);
  expect(fs.readdirSync(studioDir)).toEqual([]);
});

// This does not execute studio render/make: their intermediate/cache paths remain
// an existing development-runtime limitation, distinct from service-owned stores.
it("roots runner argv and persisted state in outputDir without changing studio working directory", () => {
  const studioDir = directory(), outputDir = path.join(directory(), "jobs");
  let args: string[] = [], config: { cwd?: string; shell?: boolean } = {};
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createJobRunner({ studioDir, outputDir, execArgs: ["fixture.mjs"], env: {}, spawnFn: (_exe: string, argv: string[], options: typeof config) => { args = argv; config = options; return child; }, killTree: () => child.emit("close", 1) });
  try {
    const result = runner.submit({ source: "# Desktop\nLocal source." });
    expect(result.jobId).toBeTruthy();
    expect(args.find(arg => arg.startsWith("--out="))).toBe(`--out=${path.join(outputDir, `${result.jobId}.mp4`)}`);
    expect(args.find(arg => arg.startsWith("--source="))).toBe(`--source=${path.join(outputDir, ".jobs", `${result.jobId}.md`)}`);
    expect(config).toMatchObject({ cwd: studioDir, shell: false });
    expect(fs.readdirSync(studioDir)).toEqual([]);
  } finally { runner.dispose(); }
});

it("closes active connections, disposes once and returns the same repeated-close promise", async () => {
  const dispose = vi.fn();
  const service = await start({ makeRunner: { dispose } });
  await fetch(`${service.url}/api/health`);
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(service.url).port) });
  await once(socket, "connect");
  socket.write("POST /api/session/open HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{");
  socket.on("error", error => { expect((error as NodeJS.ErrnoException).code).toBe("ECONNRESET"); });
  const disconnected = new Promise<void>(resolve => socket.once("close", () => resolve()));
  const first = service.close(); expect(service.close()).toBe(first);
  await first; await disconnected; await service.close(); expect(dispose).toHaveBeenCalledTimes(1);
  await expect(fetch(`${service.url}/api/health`)).rejects.toThrow();
});

it("bounds shutdown even when runner disposal never settles", async () => {
  const service = await start({ timeoutMs: 30, makeRunner: { dispose: () => new Promise(() => {}) } });
  await expect(service.close()).rejects.toThrow("shutdown timed out");
  await expect(fetch(`${service.url}/api/health`)).rejects.toThrow();
});

it.each([{ dataDir: "" }, { host: "0.0.0.0" }, { host: "::1" }, { port: 4175 }, { timeoutMs: 0 }, { timeoutMs: Infinity }])("rejects unsafe/invalid configuration before starting: %j", async options => {
  await expect(start(options)).rejects.toThrow();
});

it("CLI emits exactly the agreed ready record and accepts only nonce-bound stdin shutdown", async () => {
  const dataDir = directory();
  const run = child([`--data-dir=${dataDir}`, `--nonce=${nonce}`]);
  const ready = await run.ready;
  expect(ready).toEqual({ type: "ready", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), nonce });
  expect((await fetch(`${ready.url}/api/health`)).status).toBe(200);
  expect((await post(`${ready.url}/api/session/open`, { projectId: project.id, project })).status).toBe(200);
  run.process.stdin.write(JSON.stringify({ type: "shutdown", nonce }) + "\n");
  expect((await run.closed)[0]).toBe(0);
  expect(run.output()).toEqual({ stdout: JSON.stringify(ready) + "\n", stderr: "" });
  expect(fs.readdirSync(dataDir).sort()).toEqual(["checks", "jobs", "media", "sessions"]);
  await expect(fetch(`${ready.url}/api/health`)).rejects.toThrow();
}, 20000);

it("CLI exits when parent disconnects stdin, including while startup is pending", async () => {
  for (const early of [false, true]) {
    const run = child([`--data-dir=${directory()}`, `--nonce=${nonce}`]);
    const ready = early ? undefined : await run.ready;
    run.process.stdin.end();
    expect((await run.closed)[0]).toBe(0);
    expect(run.output().stderr).toBe("");
    if (ready) await expect(fetch(`${ready.url}/api/health`)).rejects.toThrow();
  }
}, 20000);

it.each(["not JSON\n", JSON.stringify({ type: "shutdown", nonce: "wrong" }) + "\n", JSON.stringify({ type: "execute", nonce }) + "\n", JSON.stringify({ type: "shutdown", nonce, command: "echo SECRET" }) + "\n", "x".repeat(4097)])("CLI rejects unexpected stdin without evaluating it", async control => {
  const run = child([`--data-dir=${directory()}`, `--nonce=${nonce}`]);
  const ready = await run.ready;
  run.process.stdin.write(control);
  expect((await run.closed)[0]).toBe(1);
  expect(run.output()).toEqual({ stdout: JSON.stringify(ready) + "\n", stderr: "Desktop control message rejected\n" });
}, 20000);

it("CLI rejects truncated control input on EOF", async () => {
  const run = child([`--data-dir=${directory()}`, `--nonce=${nonce}`]);
  await run.ready; run.process.stdin.end("{\"type\":");
  expect((await run.closed)[0]).toBe(1);
  expect(run.output().stderr).toBe("Desktop control message rejected\n");
}, 20000);

it.each([[], ["--data-dir=x"], ["--nonce=short", "--data-dir=x"], [`--nonce=${nonce}`, "--data-dir="], [`--nonce=${nonce}`, "--data-dir=x", "--host=0.0.0.0"]].map(args => ({ args })))("CLI requires exact arguments and never leaks credentials: $args", async ({ args }) => {
  const run = child(args);
  expect((await run.closed)[0]).toBe(1);
  expect(run.output().stdout).toBe("");
  expect(run.output().stderr).toBe("Desktop service requires --data-dir=<directory> and --nonce=<random boot token>\n");
}, 20000);

it("CLI reports startup failure without a ready line, local path or credential", async () => {
  const dataDir = path.join(directory(), "SECRET-PATH"); fs.writeFileSync(dataDir, "not a directory");
  const run = child([`--data-dir=${dataDir}`, `--nonce=${nonce}`]);
  expect((await run.closed)[0]).toBe(1);
  expect(run.output().stdout).toBe("");
  expect(run.output().stderr).not.toMatch(/SECRET|apiKey|Error:|at /);
}, 20000);
