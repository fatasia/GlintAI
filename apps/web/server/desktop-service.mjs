import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CONTROL_BYTES = 4096;
const STUDIO_DIR = fileURLToPath(new URL("../../studio/", import.meta.url));
let dependencies;

function loadDependencies(dataDir) {
  // Set paths before index's module-level defaults are constructed. Never load .env
  // from cwd: the native parent owns configuration and credentials in development.
  if (!dependencies) {
    process.env.GLINT_DATA_DIR = dataDir;
    process.env.GLINT_CACHE_DIR = path.join(dataDir, "cache");
    process.env.GLINT_SESSION_DIR = path.join(dataDir, "sessions");
    dependencies = Promise.all([
      import("./index.mjs"), import("./jobs.mjs"), import("./media-jobs.mjs"),
      import("./checks.mjs"), import("@glintai/session/node"), import("@glintai/scenescript"),
    ]);
  }
  return dependencies;
}

/** Development-only host. No stdout, stdin or process signal ownership when imported.
 * instanceToken identifies this boot to its caller; it is NOT an HTTP credential.
 * Existing local web access policy remains unchanged; never bind a network address.
 */
export async function startDesktopService({ dataDir, studioDir = STUDIO_DIR, timeoutMs = DEFAULT_TIMEOUT_MS,
  host = HOST, port = 0, makeRunner, mediaJobs, checkStore, sessionStore,
  distDir, engineForProject, llmSettings,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("Choose a writable desktop data directory");
  if (host !== HOST || port !== 0) throw new Error("Desktop service requires 127.0.0.1 and port 0");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Desktop timeout must be 1..60000 milliseconds");
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const [{ createWebServer }, { createJobRunner }, { createMediaJobs }, { createCheckStore },
    { FileSessionStore }, { parseProject }] = await loadDependencies(root);
  const media = mediaJobs ?? createMediaJobs(path.join(root, "media"));
  const bundledEntry = process.env.GLINT_MAKE_ENTRY;
  const runner = makeRunner ?? createJobRunner({ studioDir: path.resolve(process.env.GLINT_STUDIO_DIR ?? studioDir), outputDir: path.join(root, "jobs"),
    musicAsset: name => media.asset(name),
    ...(bundledEntry ? { execPath: process.env.GLINT_MAKE_NODE ?? process.execPath, execArgs: [bundledEntry] } : {}) });
  let server;
  let closing;
  const close = () => closing ??= (async () => {
    let timer;
    try {
      await Promise.race([
        (async () => {
          let disposal;
          try { disposal = Promise.resolve(runner.dispose()); }
          catch (error) { disposal = Promise.reject(error); }
          server?.closeAllConnections();
          await Promise.all([disposal, server ? new Promise((resolve, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())) : undefined]);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Desktop shutdown timed out")), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); server?.closeAllConnections(); }
  })();
  try {
    server = createWebServer({ makeRunner: runner, mediaJobs: media,
      checkStore: checkStore ?? createCheckStore(path.join(root, "checks")),
      sessionStore: sessionStore ?? new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }),
      distDir, engineForProject, llmSettings, ttsCacheDir: path.join(root, "cache", "tts"),
      // null intentionally overrides inherited GLINT_PUBLIC_HOST without changing auth.
      publicHost: null, accessToken: undefined, authRequired: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); reject(new Error("Desktop listen timed out")); }, timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      server.once("error", fail);
      server.listen(0, HOST, () => { clearTimeout(timer); server.off("error", fail); resolve(); });
    });
    return { url: `http://${HOST}:${server.address().port}`, instanceToken: randomBytes(32).toString("hex"), close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function runCli() {
  // stdout is exactly one NDJSON ready record for Rust. Diagnostics never include
  // arguments, provider errors, paths, environment values or HTTP credentials.
  let options;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args.filter(arg => arg.startsWith("--data-dir=")).length !== 1 || args.filter(arg => arg.startsWith("--nonce=")).length !== 1) throw new Error();
    const dataDir = args.find(arg => arg.startsWith("--data-dir=")).slice(11);
    const nonce = args.find(arg => arg.startsWith("--nonce=")).slice(8);
    if (!dataDir.trim() || !/^[a-zA-Z0-9_-]{16,256}$/.test(nonce)) throw new Error();
    options = { dataDir, nonce };
  } catch { process.stderr.write("Desktop service requires --data-dir=<directory> and --nonce=<random boot token>\n"); process.exitCode = 1; return; }
  let service;
  let stopped = false;
  let buffer = "";
  let startup;
  const stop = async (invalid = false) => {
    if (stopped) return;
    stopped = true;
    process.stdin.pause();
    if (invalid) process.stderr.write("Desktop control message rejected\n");
    const deadline = setTimeout(() => process.exit(1), DEFAULT_TIMEOUT_MS + 100);
    try { await startup; await service?.close(); process.exitCode = invalid ? 1 : 0; }
    catch { process.stderr.write("Desktop service cleanup failed\n"); process.exitCode = 1; }
    finally {
      clearTimeout(deadline);
      process.stdin.off("data", input); process.stdin.off("end", ended); process.stdin.off("error", disconnected);
      process.off("SIGTERM", disconnected); process.off("SIGINT", disconnected);
      // A runner may still be reaping a process tree. CLI owns this process.
      process.exit(process.exitCode ?? 0);
    }
  };
  const disconnected = () => { void stop(); };
  const ended = () => { void stop(Boolean(buffer.length)); };
  const input = chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES) { void stop(true); return; }
    let end;
    while (!stopped && (end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (!message || Object.keys(message).sort().join(",") !== "nonce,type" || message.type !== "shutdown" || message.nonce !== options.nonce) throw new Error();
        void stop();
      } catch { void stop(true); }
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", input); process.stdin.on("end", ended); process.stdin.on("error", disconnected);
  process.on("SIGTERM", disconnected); process.on("SIGINT", disconnected);
  process.stdout.on("error", disconnected);
  startup = startDesktopService({ dataDir: options.dataDir }).then(value => { service = value; });
  try {
    await startup;
    if (!stopped) process.stdout.write(`${JSON.stringify({ type: "ready", url: service.url, nonce: options.nonce })}\n`);
  } catch { process.stderr.write("Desktop service startup failed; check the writable data directory and installed development dependencies\n"); void stop(true); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
