import http from "node:http";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createDesktopSessionRegistry } from "./desktop-session-capability.mjs";

// Isolated experiment only. A production host must supply frame/origin metadata from
// the native WebView, never from a renderer-controlled IPC payload.
const LIFETIME_MS = 60_000;
const MAX_LINE = 4096;

export async function runIdentityPrototype() {
  const registry = createDesktopSessionRegistry();
  let origin;
  const server = http.createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    // Require an exact origin even for GET, including scheme and port. The test
    // endpoint is intentionally distinct from every production migration route.
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin ||
        req.method !== "GET" || req.url !== "/identity-prototype" ||
        !registry.resolve(req)) {
      res.writeHead(403); res.end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(JSON.stringify({ type: "ready", origin }) + "\n");
  let buffer = "", stopped = false;
  function close() {
    if (stopped) return;
    stopped = true; registry.close(); process.stdin.pause();
    server.closeAllConnections(); server.close(() => process.exit(0));
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE) return close();
    let at;
    while (!stopped && (at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try {
        const msg = JSON.parse(line);
        if (!msg || !Number.isSafeInteger(msg.id) || msg.id < 1 || typeof msg.type !== "string") throw new Error();
        const keys = Object.keys(msg).sort().join(",");
        let result;
        if (msg.type === "issue" && keys === "id,type") result = registry.issue(LIFETIME_MS);
        else if (msg.type === "revoke" && keys === "id,token,type" && typeof msg.token === "string") { registry.revoke(msg.token); result = true; }
        else if (msg.type === "shutdown" && keys === "id,type") return close();
        else throw new Error();
        process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\n");
      } catch { close(); }
    }
  });
  process.stdin.on("end", close); process.stdin.on("error", close); process.stdout.on("error", close);
}

/** Host-side model. The caller must be a native adapter providing trustworthy
 * document identity, frame status and origin. This is not a Tauri adapter. */
export function createIdentityPrototypeHost(child, origin, { timeoutMs = 3000 } = {}) {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("Invalid owned origin");
  origin = parsed.origin;
  let nextId = 0, closed = false, generation = 0, current;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  function fail() {
    if (closed) return;
    closed = true; generation++; current = undefined;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Private control channel closed")); }
    pending.clear(); lines.close(); child.kill();
  }
  child.once("error", fail); child.once("exit", fail); child.stdin.on("error", fail);
  lines.on("line", line => {
    try {
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error();
      const msg = JSON.parse(line), item = pending.get(msg.id);
      if (!item || Object.keys(msg).sort().join(",") !== "id,result") throw new Error();
      pending.delete(msg.id); clearTimeout(item.timer); item.resolve(msg.result);
    } catch { fail(); }
  });
  function control(type, extra = {}) {
    if (closed) return Promise.reject(new Error("Private control channel closed"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(fail, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  }
  function verify(source) {
    return source && source.mainFrame === true && source.origin === origin &&
      typeof source.document === "object" && source.document !== null;
  }
  async function revoke() {
    generation++;
    const previous = current; current = undefined;
    if (previous) await control("revoke", { token: previous.token });
  }
  return {
    async attach(source) {
      if (!verify(source)) throw new Error("Untrusted WebView document");
      const clearing = revoke();
      const epoch = generation;
      await clearing;
      if (epoch !== generation || closed) throw new Error("Document changed during issuance");
      const token = await control("issue");
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) { fail(); throw new Error("Invalid private response"); }
      if (closed || epoch !== generation) { if (!closed) await control("revoke", { token }); throw new Error("Document changed during issuance"); }
      current = { document: source.document, token };
    },
    async probe(source, { signal } = {}) {
      if (!verify(source) || !current || source.document !== current.document) throw new Error("Untrusted or revoked WebView document");
      const epoch = generation;
      const response = await fetch(origin + "/identity-prototype", { headers: { authorization: `Bearer ${current.token}`, origin }, redirect: "error", cache: "no-store", signal });
      if (epoch !== generation) throw new Error("Document changed during request");
      if (!response.ok) throw new Error("Identity capability rejected");
      return response.json();
    },
    revoke,
    close() { fail(); },
  };
}

// This entrypoint is never imported by the production desktop service.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "--isolated-child") {
  runIdentityPrototype().catch(() => { process.exitCode = 1; });
}
