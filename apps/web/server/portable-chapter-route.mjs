import { createHash, randomBytes } from "node:crypto";
import { exportPortableChapters, preflightPortableChapters, importPortableChapters } from "./portable-chapter-migration.ts";

const LIMIT = 32 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60_000;
const MAX_TOKENS = 256;
const REQUEST_TIMEOUT_MS = 45_000;
const busyLibraries = new WeakSet();

function readPackage(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", abort);
      signal.removeEventListener("abort", abort);
    };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => { req.resume(); fail(signal.reason ?? new Error("请求已取消。")); };
    const data = chunk => {
      size += chunk.length;
      if (size > LIMIT) {
        fail(Object.assign(new Error("迁移包超过 32 MiB。"), { status: 413 }));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      const bytes = Buffer.concat(chunks, size);
      try {
        const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        resolve({ body, digest: createHash("sha256").update(bytes).digest("hex") });
      } catch { reject(new Error("迁移包不是有效的 UTF-8 文本。")); }
    };
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Isolated adapter only. resolveSession must authenticate a server-side session,
 * not return an untrusted request header as the session identity. */
export function createPortableChapterHandler({ resolveSession, isSessionActive, openAssetStore, now = () => performance.now(), requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > REQUEST_TIMEOUT_MS) throw new RangeError("Invalid request timeout");
  if (typeof resolveSession !== "function" || typeof isSessionActive !== "function") throw new TypeError("A revocable trusted session resolver is required.");
  if (typeof openAssetStore !== "function") throw new TypeError("A pinned secure asset store is required.");
  const tokens = new Map();
  const stores = new Map();
  let closed = false;
  const prune = () => {
    const time = now();
    for (const [token, grant] of tokens) if (time >= grant.expiresAt) tokens.delete(token);
  };
  async function storeFor(media, root) {
    if (closed) throw new Error("迁移服务已关闭。");
    let entry = stores.get(media);
    if (entry && entry.root !== root) throw new Error("素材库目录发生变化。");
    if (entry) {
      const store = await entry.promise;
      if (closed) throw new Error("迁移服务已关闭。");
      if (typeof store?.isUsable !== "function" || store.isUsable()) return store;
      if (stores.get(media) === entry) stores.delete(media);
      await store.close();
    }
    if (closed) throw new Error("迁移服务已关闭。");
    entry = stores.get(media);
    if (!entry) {
      entry = { root, promise: Promise.resolve().then(() => openAssetStore(root)) };
      stores.set(media, entry);
    }
    try {
      const store = await entry.promise;
      if (closed) throw new Error("迁移服务已关闭。");
      return store;
    } catch (error) { if (!closed && stores.get(media) === entry) stores.delete(media); throw error; }
  }
  const handler = async function handlePortableChapter(req, res, url, { media, sendJson }) {
    return handleRequest(req, res, url, { media, sendJson, resolveSession, isSessionActive: session => !closed && isSessionActive(session), storeFor, tokens, prune, now, requestTimeoutMs });
  };
  let closing;
  handler.close = () => closing ??= (async () => { closed = true; tokens.clear(); for (const store of stores.values()) { try { await (await store.promise)?.close(); } catch { /* Failed bridges have no resources to retain. */ } } stores.clear(); })();
  return handler;
}

// Not mounted in production: the native host has not established a trusted session
// delivery channel or excluded same-user modification of the library and executable.
async function handleRequest(req, res, url, { media, sendJson, resolveSession, isSessionActive, storeFor, tokens, prune, now, requestTimeoutMs }) {
  const routes = ["/api/chapters/export-bundle", "/api/chapters/preview-bundle", "/api/chapters/commit-bundle"];
  if (req.method !== "POST" || !routes.includes(url.pathname)) return false;
  if (typeof media.portableChapterRoot !== "function") { sendJson(res, 503, { error: "含素材章节包暂不可用：素材库不支持安全迁移。" }); return true; }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] ?? "")) { sendJson(res, 415, { error: "需要 JSON 请求。" }); return true; }
  res.setHeader("cache-control", "no-store");
  let session;
  try { session = await resolveSession(req); }
  catch { sendJson(res, 503, { error: "无法验证会话，请稍后重试。" }); return true; }
  if (typeof session !== "string" || !session) { sendJson(res, 401, { error: "会话无效，请重新打开页面。" }); return true; }
  const authorizeSession = () => {
    if (isSessionActive(session) !== true) throw Object.assign(new Error("会话已失效，请重新打开页面。"), { status: 401 });
  };
  if (busyLibraries.has(media)) { sendJson(res, 429, { error: "章节迁移正在进行，请稍后重试。" }); return true; }
  busyLibraries.add(media);
  const controller = new AbortController();
  const stop = () => { if (!res.writableEnded) controller.abort(); };
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error("章节迁移请求超时，请重试。"), { status: 503 })), requestTimeoutMs);
  res.once("close", stop);
  let store;
  try {
    authorizeSession();
    const root = media.portableChapterRoot();
    try {
      store = await storeFor(media, root);
      if (!store || typeof store.read !== "function" || typeof store.publish !== "function" || typeof store.close !== "function") throw new Error("invalid asset store");
    }
    catch { throw Object.assign(new Error("安全素材桥不可用，请稍后重试。"), { status: 503 }); }
    const library = store;
    const { body, digest } = await readPackage(req, controller.signal);
    authorizeSession();
    if (url.pathname.endsWith("export-bundle")) {
      const input = JSON.parse(body);
      const serialized = await exportPortableChapters(input.chapters, name => { authorizeSession(); return store.read(name); }, controller.signal);
      authorizeSession();
      if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(serialized); }
    } else {
      prune();
      if (url.pathname.endsWith("commit-bundle")) {
        const token = req.headers["x-glint-confirm-import"];
        const grant = typeof token === "string" ? tokens.get(token) : undefined;
        if (!grant || grant.session !== session || grant.media !== media || grant.digest !== digest) {
          sendJson(res, 403, { error: "预检凭证无效或已过期，请重新预检并确认。" }); return true;
        }
        const authorize = () => {
          authorizeSession();
          if (now() >= grant.expiresAt || tokens.get(token) !== grant) {
            tokens.delete(token);
            throw Object.assign(new Error("预检凭证已过期，请重新预检并确认。"), { status: 403 });
          }
        };
        const result = await importPortableChapters(body, library, controller.signal, authorize);
        authorize();
        if (!res.destroyed) sendJson(res, 200, result);
      } else {
        if (tokens.size >= MAX_TOKENS) { sendJson(res, 429, { error: "预检数量已达上限，请稍后重试。" }); return true; }
        const result = await preflightPortableChapters(body, library, controller.signal);
        authorizeSession();
        if (!res.destroyed) {
          prune();
          if (tokens.size >= MAX_TOKENS) { sendJson(res, 429, { error: "预检数量已达上限，请稍后重试。" }); return true; }
          const token = randomBytes(32).toString("base64url");
          tokens.set(token, { session, media, digest, expiresAt: now() + TOKEN_TTL_MS });
          sendJson(res, 200, { ...result, token, expiresInMs: TOKEN_TTL_MS });
        }
      }
    }
  } catch (error) {
    if (!res.destroyed) sendJson(res, [401, 403, 413, 503].includes(error?.status) ? error.status : 400, { error: error instanceof Error ? error.message : "章节迁移失败。" });
  } finally { clearTimeout(timeout); res.off("close", stop); busyLibraries.delete(media); }
  return true;
}
