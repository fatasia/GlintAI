import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDesktopAgentControl } from "./desktop-agent-control.mjs";

const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
// 完整 NDJSON envelope（含换行），与 Rust protocol::MAX_RESPONSE_BYTES 一致。
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024 + 64 * 1024;
const RESPONSE_TOO_LARGE = "桌面服务响应过大，请缩小查询范围后重试。";
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
  distDir, engineForProject, llmSettings, agentHost,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("Choose a writable desktop data directory");
  if (host !== HOST || port !== 0) throw new Error("Desktop service requires 127.0.0.1 and port 0");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Desktop timeout must be 1..60000 milliseconds");
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });
  // Keep WebView storage on one origin across boots. Never fall back silently
  // when occupied: that would hide the user's documents behind another origin.
  const originFile = path.join(root, "desktop-origin.json");
  let savedPort = 0;
  if (fs.existsSync(originFile)) {
    let record;
    try { record = JSON.parse(fs.readFileSync(originFile, "utf8")); }
    catch { throw new Error("Desktop origin record is unreadable; preserve it and restore from backup"); }
    if (record?.version !== 1 || !Number.isInteger(record.port) || record.port < 1024 || record.port > 65535)
      throw new Error("Desktop origin record is invalid; no new origin was created");
    savedPort = record.port;
  }
  const agents = agentHost ?? createDesktopAgentControl({ dataDir: path.join(root, "agents"), mediaDir: path.join(root, "media") });
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
          try { disposal = Promise.all([Promise.resolve(runner.dispose()), Promise.resolve(agents.dispose())]); }
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
      // Explicit: the module-level DATA_DIR default is frozen by whichever service imported index.mjs first.
      requestLogDir: path.join(root, "logs"),
      distDir, engineForProject, llmSettings, ttsCacheDir: path.join(root, "cache", "tts"),
      // null intentionally overrides inherited GLINT_PUBLIC_HOST without changing auth.
      publicHost: null, accessToken: undefined, authRequired: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); reject(new Error("Desktop listen timed out")); }, timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      server.once("error", fail);
      server.listen(savedPort, HOST, () => { clearTimeout(timer); server.off("error", fail); resolve(); });
    });
    if (!savedPort) {
      // Exclusive creation makes simultaneous first boots fail closed rather than
      // racing to replace the origin record. A failed boot closes its own server.
      fs.writeFileSync(originFile, JSON.stringify({ version: 1, port: server.address().port }), { flag: "wx", mode: 0o600 });
    }
    return { url: `http://${HOST}:${server.address().port}`, instanceToken: randomBytes(32).toString("hex"),
      agentRequest: request => agents.request(request), close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

export async function runCli({ startService = startDesktopService } = {}) {
  // CLI 独占协议输出；依赖和工具的日志不得混入协议或泄漏到诊断通道。
  const writeProtocol = process.stdout.write.bind(process.stdout);
  const writeDiagnostic = process.stderr.write.bind(process.stderr);
  const discard = (_chunk, encoding, callback) => {
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  const sendResult = message => {
    let line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
      line = `${JSON.stringify({ type: "agent-result", id: message.id, error: RESPONSE_TOO_LARGE })}\n`;
    }
    writeProtocol(line);
  };
  let options;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args.filter(arg => arg.startsWith("--data-dir=")).length !== 1 || args.filter(arg => arg.startsWith("--nonce=")).length !== 1) throw new Error();
    const dataDir = args.find(arg => arg.startsWith("--data-dir=")).slice(11);
    const nonce = args.find(arg => arg.startsWith("--nonce=")).slice(8);
    if (!dataDir.trim() || !/^[a-zA-Z0-9_-]{16,256}$/.test(nonce)) throw new Error();
    options = { dataDir, nonce };
  } catch { writeDiagnostic("Desktop service requires --data-dir=<directory> and --nonce=<random boot token>\n"); process.exitCode = 1; return; }
  let service;
  let stopped = false;
  let buffer = "";
  let startup;
  const stop = async (invalid = false) => {
    if (stopped) return;
    stopped = true;
    process.stdin.pause();
    if (invalid) writeDiagnostic("Desktop control message rejected\n");
    const deadline = setTimeout(() => process.exit(1), DEFAULT_TIMEOUT_MS + 100);
    try { await startup; await service?.close(); process.exitCode = invalid ? 1 : 0; }
    catch { writeDiagnostic("Desktop service cleanup failed\n"); process.exitCode = 1; }
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
    let end;
    while (!stopped && (end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) + 1 > MAX_CONTROL_BYTES) { void stop(true); return; }
      try {
        const message = JSON.parse(line);
        if (!message || message.nonce !== options.nonce) throw new Error();
        const keys = Object.keys(message).sort().join(",");
        if (message.type === "shutdown" && keys === "nonce,type") { void stop(); continue; }
        if (message.type !== "agent" || keys !== "id,nonce,request,type" || !Number.isSafeInteger(message.id) || message.id < 1 || !message.request || typeof message.request.action !== "string") throw new Error();
        void startup.then(async () => {
          try {
            const result = await service.agentRequest(message.request);
            if (!stopped) sendResult({ type: "agent-result", id: message.id, result });
          } catch {
            if (!stopped) sendResult({ type: "agent-result", id: message.id, error: "本地智能体操作未完成，请重试。" });
          }
        });
      } catch { void stop(true); }
    }
    if (Buffer.byteLength(buffer) >= MAX_CONTROL_BYTES) void stop(true);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", input); process.stdin.on("end", ended); process.stdin.on("error", disconnected);
  process.on("SIGTERM", disconnected); process.on("SIGINT", disconnected);
  process.stdout.on("error", disconnected);
  startup = startService({ dataDir: options.dataDir }).then(value => { service = value; });
  try {
    await startup;
    if (!stopped) writeProtocol(`${JSON.stringify({ type: "ready", url: service.url, nonce: options.nonce })}\n`);
  } catch { writeDiagnostic("Desktop service startup failed; check the writable data directory and installed development dependencies\n"); void stop(true); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
