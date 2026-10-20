import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnswerEngine, loadMarkdown, LexicalKnowledgeBase } from "@glintai/knowledge";
import { OpenAICompatibleProvider } from "@glintai/llm";
import { TEMPLATES, composeFromMarkdown, composeFromSource, composeWithLlm, reviewProject } from "@glintai/composer";
import { parseProject } from "@glintai/scenescript";
import { PERSONA_CATALOG, parsePersonaCatalog } from "@glintai/listener/catalog";
import { createJobRunner } from "./jobs.mjs";
import { createCheckStore } from "./checks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const EXAMPLES = path.join(__dirname, "..", "..", "..", "examples");
const PROJECTS = {
  entropy: { id: "entropy-lecture", dir: "entropy-lecture" },
  uncertainty: { id: "uncertainty-principle", dir: "uncertainty-principle" },
};
const engines = new Map();
function getEngine(projectKey) {
  const project = PROJECTS[projectKey];
  if (!project || !process.env.GLINT_LLM_API_KEY) return null;
  if (engines.has(projectKey)) return engines.get(projectKey);
  const kb = new LexicalKnowledgeBase();
  kb.addDocument(loadMarkdown(fs.readFileSync(path.join(EXAMPLES, project.dir, "source.md"), "utf8"), { docId: project.id }));
  const llm = new OpenAICompatibleProvider({
    baseUrl: process.env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.GLINT_LLM_API_KEY,
    model: process.env.GLINT_LLM_MODEL ?? "glm-4",
  });
  const engine = new AnswerEngine({ kb, llm, topK: 4 });
  engines.set(projectKey, engine);
  return engine;
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(payload));
}
function readBody(req, signal, maxBytes = 20_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const aborted = () => fail(signal.reason ?? new Error("Request cancelled"));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(Object.assign(new Error("Request body too large"), { status: 413 })); req.resume(); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
async function sendEvent(res, payload, signal) {
  signal.throwIfAborted();
  if (res.write(`data: ${JSON.stringify(payload)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", drain); res.off("error", fail); signal.removeEventListener("abort", aborted); };
    const drain = () => { cleanup(); resolve(); };
    const fail = (error) => { cleanup(); reject(error); };
    const aborted = () => fail(signal.reason);
    res.once("drain", drain); res.once("error", fail);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

const STUDIO_DIR = path.join(__dirname, "..", "..", "studio");
const defaultMakeRunner = createJobRunner({ studioDir: STUDIO_DIR, templates: TEMPLATES });
const defaultCheckStore = createCheckStore(path.join(STUDIO_DIR, "out", ".checks"));

/** Injection keeps HTTP contract tests local and independent of API credentials. */
export function createWebServer({ engineForProject = getEngine, timeoutMs = 65_000, makeRunner = defaultMakeRunner, checkStore = defaultCheckStore, personaCatalog = PERSONA_CATALOG, distDir = DIST } = {}) {
  const jobs = makeRunner;
  const personas=parsePersonaCatalog(personaCatalog);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let localHost = false;
    try { localHost = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${req.headers.host}`).hostname); } catch { /* Invalid host. */ }
    if (!localHost) return sendJson(res, 403, { error: "This service accepts local hosts only" });
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { status: "ok", service: "glint-web", version: process.env.GLINT_VERSION ?? "0.1.0", modelConfigured: Boolean(process.env.GLINT_LLM_API_KEY), voices: ["mock", "edge", ...(process.platform === "win32" ? ["sapi"] : []), ...(process.env.GLINT_QWEN_MODEL && process.env.GLINT_QWEN_REFERENCE ? ["qwen"] : [])], uptimeSeconds: Math.round(process.uptime()) });
    }
    if(req.method === "GET" && url.pathname === "/api/personas")return sendJson(res,200,personas);
    const personaPack=url.pathname.match(/^\/api\/personas\/([a-z0-9-]+)$/);
    if(req.method === "GET" && personaPack){
      const entry=personas.entries.find(entry=>entry.id===personaPack[1]);
      if(!entry)return sendJson(res,404,{error:"Unknown persona pack"});
      res.setHeader("content-disposition",`attachment; filename="${entry.id}.json"`);
      return sendJson(res,200,{version:1,personas:entry.personas});
    }
    if (["POST", "DELETE"].includes(req.method) && req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* Invalid origin. */ }
      if (!sameOrigin) return sendJson(res, 403, { error: "Cross-origin mutation rejected" });
    }
    if (["/api/compose", "/api/review"].includes(url.pathname) && req.method === "POST") {
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", disconnected);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 300_000));
        const source = typeof body.source === "string" ? body.source.trim() : "";
        const idea = typeof body.idea === "string" ? body.idea.trim() : "";
        if (source.length > 12000 || idea.length > 2000) return sendJson(res, 400, { error: "Input exceeds limit" });
        if (url.pathname === "/api/review") {
          if (!source) return sendJson(res, 400, { error: "Source required for evidence review" });
          return sendJson(res, 200, reviewProject(parseProject(body.project), source));
        }
        if (Boolean(source) === Boolean(idea)) return sendJson(res, 400, { error: "Choose source or idea" });
        const options = { projectId: "editor-project", template: body.template ?? "explainer", theme: body.theme ?? "glint-dark", aspect: body.aspect ?? "16:9" };
        let project, basis = source;
        if (idea || body.engine === "llm") {
          if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "Configure GLINT_LLM_API_KEY to use model composition" });
          const llm = new OpenAICompatibleProvider({ baseUrl: process.env.GLINT_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", apiKey: process.env.GLINT_LLM_API_KEY, model: process.env.GLINT_LLM_MODEL ?? "glm-4" });
          if (idea) {
            const composed = await composeFromSource({ idea }, llm, options, { signal: controller.signal });
            project = composed.project; basis = composed.sourceText;
          } else project = await composeWithLlm(source, llm, options, { signal: controller.signal });
        } else project = composeFromMarkdown(source, options);
        return sendJson(res, 200, { project, source: basis, generatedSource: Boolean(idea), review: reviewProject(project, basis) });
      } catch (error) { if (!res.destroyed) return sendJson(res, error.status ?? 400, { error: "Composition/review failed. Check source structure, template requirements and model configuration." }); }
      finally { res.off("close", disconnected); }
      return;
    }
    const checkPath = url.pathname.match(/^\/api\/checks\/([\w-]+)(\/stats)?$/);
    if (checkPath) {
      const project = checkPath[1];
      if (req.method === "GET") {
        const result = checkPath[2] ? checkStore.stats(project) : checkStore.questions(project);
        return sendJson(res, result ? 200 : 404, result ?? { error: "Unknown project" });
      }
      if (req.method !== "POST" || checkPath[2]) return sendJson(res, 405, { error: "Method not allowed" });
      try {
        const body = JSON.parse(await readBody(req, new AbortController().signal));
        return sendJson(res, 200, checkStore.submit(project, body));
      } catch (error) { return sendJson(res, error.status ?? 400, { error: "Invalid check submission" }); }
    }
    if (url.pathname === "/api/make" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req, new AbortController().signal, 300_000));
        if (!body?.source && !body?.project && !process.env.GLINT_LLM_API_KEY) {
          return sendJson(res, 503, { error: "One-sentence video requires GLINT_LLM_* server credentials." });
        }
        const submitted = jobs.submit(body ?? {});
        if (submitted.error) return sendJson(res, 400, { error: submitted.error });
        sendJson(res, 200, { jobId: submitted.jobId });
      } catch (error) {
        sendJson(res, error instanceof SyntaxError ? 400 : error.status ?? 500, { error: "Generation request failed. Check input and local server configuration." });
      }
      return;
    }
    const requestLookup = url.pathname.match(/^\/api\/make\/request\/([a-zA-Z0-9-]{8,80})$/);
    if (requestLookup && req.method === "GET") {
      const job = jobs.findRequest?.(requestLookup[1]);
      return sendJson(res, job ? 200 : 404, job ?? { error: "No task found for this request. Retry lookup before submitting again." });
    }
    const makeStatus = url.pathname.match(/^\/api\/make\/([\w-]+)$/);
    if (makeStatus && req.method === "GET") {
      const job = jobs.get(makeStatus[1]);
      if (!job) return sendJson(res, 404, { error: "Unknown job" });
      return sendJson(res, 200, job);
    }
    if (makeStatus && req.method === "DELETE") {
      const cancelled = jobs.cancel(makeStatus[1]);
      if (!cancelled) return sendJson(res, 404, { error: "Job not cancellable" });
      return sendJson(res, 200, { cancelled: true });
    }
    const makeVideo = url.pathname.match(/^\/api\/video\/([\w-]+)$/);
    if (makeVideo && ["GET", "HEAD"].includes(req.method)) {
      const file = jobs.videoFile(makeVideo[1]);
      if (!file || !fs.existsSync(file)) {
        return sendJson(res, 404, { error: "Video not ready" });
      }
      const size = fs.statSync(file).size;
      let start = 0, end = size - 1, status = 200;
      const headers = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff" };
      if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${makeVideo[1]}.mp4"`;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }); return res.end();
        }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }); return res.end();
        }
        status = 206; headers["content-range"] = `bytes ${start}-${end}/${size}`;
      }
      headers["content-length"] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === "HEAD") return res.end();
      const stream = fs.createReadStream(file, { start, end });
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
    if (url.pathname === "/api/ask") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST for questions." });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Question timed out", "TimeoutError")), timeoutMs);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", disconnected);
      try {
        let body;
        try { body = JSON.parse(await readBody(req, controller.signal)); }
        catch (error) { if (error instanceof SyntaxError) error.status = 400; throw error; }
        const question = typeof body?.question === "string" ? body.question : "";
        if (!question.trim()) return sendJson(res, 400, { error: "question is required" });
        if (typeof body.project !== "string" || !Object.hasOwn(PROJECTS, body.project)) return sendJson(res, 400, { error: "Unknown project" });
        const engine = engineForProject(body.project);
        if (!engine) return sendJson(res, 503, { error: "Question service unavailable. Configure GLINT_LLM_API_KEY on the server." });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
        res.flushHeaders();
        let done = false;
        for await (const event of engine.streamAnswer(question, { signal: controller.signal, timeoutMs })) {
          await sendEvent(res, event, controller.signal);
          if (event.type === "done") { done = true; break; }
        }
        if (!done) throw new Error("Answer stream ended before completion");
        res.end();
      } catch (error) {
        if (res.destroyed) return;
        // Do not forward provider response bodies, endpoints or credentials to browsers.
        const message = controller.signal.reason?.name === "TimeoutError"
          ? "Question timed out. Retry or check the model service."
          : "Question request failed. Retry or check server configuration.";
        if (!res.headersSent) sendJson(res, error.status ?? (controller.signal.aborted ? 504 : 500), { error: message });
        else res.end(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
      } finally {
        clearTimeout(timer);
        res.off("close", disconnected);
      }
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = path.resolve(distDir, file);
    if (!target.startsWith(`${path.resolve(distDir)}${path.sep}`) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) return sendJson(res, 405, { error: "Method not allowed" });
    let selected = target, encoding;
    const accepted = String(req.headers["accept-encoding"] ?? "").split(",").map(part => {
      const [name, quality] = part.trim().split(";");
      return { name, q: quality ? Number(quality.trim().replace(/^q=/, "")) : 1 };
    });
    for (const candidate of [{ name: "br", suffix: ".br" }, { name: "gzip", suffix: ".gz" }].sort((a, b) =>
      (accepted.find(x => x.name === b.name)?.q ?? 0) - (accepted.find(x => x.name === a.name)?.q ?? 0))) {
      if ((accepted.find(x => x.name === candidate.name)?.q ?? 0) > 0 && fs.existsSync(target + candidate.suffix)) { selected = target + candidate.suffix; encoding = candidate.name; break; }
    }
    const bytes = fs.readFileSync(selected);
    const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}"`;
    const headers = { "content-type": MIME[path.extname(target)] ?? "application/octet-stream", "cache-control": /[\\/][^/\\]+-[a-zA-Z0-9_-]{8,}\.(?:js|css)$/.test(target) ? "public, max-age=31536000, immutable" : "no-cache", vary: "Accept-Encoding", etag, "x-content-type-options": "nosniff", ...(encoding ? { "content-encoding": encoding } : {}) };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, "content-length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4175);
  createWebServer().listen(port, "127.0.0.1", () => console.log(`[glint-web] serving ${DIST} on http://localhost:${port}`));
}
