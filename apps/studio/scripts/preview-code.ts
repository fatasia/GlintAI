import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { analyzeCodeRepo } from "@glintai/composer";
import { readArg } from "./glint-runtime";
const args = process.argv.slice(2),
  root = readArg(args, "code"),
  file = readArg(args, "preview-config"),
  out = readArg(args, "out");
if (!root || !file || !out)
  throw new Error(
    "preview-code requires --code= --preview-config=<trusted JSON> --out=<context.json>",
  );
if (fs.statSync(file).size > 64 * 1024)
  throw new Error("Preview config exceeds 64 KiB");
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (
  typeof config.command !== "string" ||
  !config.command ||
  !Array.isArray(config.args) ||
  config.args.length > 40 ||
  config.args.some((s: unknown) => typeof s !== "string" || s.length > 12000)
)
  throw new Error("Provide an executable and literal argument array");
const url = new URL(config.url);
if (
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !url.port ||
  url.username ||
  url.password
)
  throw new Error("Preview URL must be an explicit loopback HTTP port");
const ttl = config.ttlMs ?? 600_000;
if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 3600_000)
  throw new Error("Preview TTL must be 1 second..1 hour");
if (
  config.env !== undefined &&
  (!config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env) ||
    Object.entries(config.env).some(
      ([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string",
    ))
)
  throw new Error("Invalid preview environment");
const graph = analyzeCodeRepo(root);
fs.mkdirSync(path.dirname(out), { recursive: true });
let child: ChildProcess | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  ready = false,
  stopping = false,
  closed = false;
const context = {
  version: 1,
  status: "starting",
  url: url.href,
  root: path.resolve(root),
  graph,
  screenshot: null,
  scope:
    "Explicit trusted startup command; no install, script guessing or automatic interaction with the target app.",
};
const save = () => fs.writeFileSync(out, JSON.stringify(context, null, 2));
save();
const stop = () => {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  if (timer) clearTimeout(timer);
  if (child?.pid && !closed) {
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => child?.kill());
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill();
      }
    }
  } else process.exitCode = 1;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => stop());
try {
  // Refuse to claim an already running unrelated service as this process's UI.
  try {
    await fetch(url, { signal: AbortSignal.timeout(500), redirect: "error" });
    throw new Error("Preview port already responds; choose an unused port");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Preview port")) throw e;
  }
  child = spawn(config.command, config.args, {
    cwd: path.resolve(root),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: { ...process.env, ...config.env },
    stdio: "ignore",
  });
  child.once("error", () => {
    context.status = "failed";
    save();
    process.exitCode = 1;
    stop();
  });
  const closedPromise = new Promise<void>((resolve) =>
    child!.once("close", () => {
      closed = true;
      context.status = ready ? "stopped" : "failed";
      save();
      if (!ready) process.exitCode = 1;
      if (timer) clearTimeout(timer);
      process.stdin.pause();
      resolve();
    }),
  );
  timer = setTimeout(stop, ttl);
  const deadline = Date.now() + Math.min(45_000, ttl);
  while (!stopping && Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error("Preview exited before readiness");
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok && !closed && !stopping) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Preview readiness timed out");
  context.status = "ready";
  save();
  console.log(
    JSON.stringify({
      status: "ready",
      url: url.href,
      context: out,
      pid: child.pid,
    }),
  );
  await closedPromise;
} catch {
  context.status = "failed";
  save();
  process.exitCode = 1;
  stop();
  console.error(
    "Preview failed; check the explicit command, port and local dependencies. Child logs are not exposed.",
  );
}
