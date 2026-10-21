import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnswerEngine, loadMarkdown, LexicalKnowledgeBase } from "@glintai/knowledge";
import { llmFromEnvironment } from "@glintai/llm";
import { TEMPLATES, composeFromMarkdown, composeFromSource, composeWithLlm, reviewProject } from "@glintai/composer";
import { parseProject } from "@glintai/scenescript";
import { PERSONA_CATALOG, parsePersonaCatalog } from "@glintai/listener/catalog";
import { configuredVoiceEngines, createConfiguredTtsProvider, synthesizeBatch } from "@glintai/tts";
import { createJobRunner } from "./jobs.mjs";
import { createCheckStore } from "./checks.mjs";
import { createLlmSettings } from "./llm-settings.mjs";
import { reexplain } from "@glintai/listener";
import { requestAccess } from "./access.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

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
  const llm = llmFromEnvironment();
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
const defaultMediaJobs = createMediaJobs(path.join(STUDIO_DIR, "out", ".media"));
const defaultMakeRunner = createJobRunner({ studioDir: STUDIO_DIR, templates: TEMPLATES, musicAsset: name => defaultMediaJobs.asset(name) });
const defaultCheckStore = createCheckStore(path.join(STUDIO_DIR, "out", ".checks"));

/** Injection keeps HTTP contract tests local and independent of API credentials. */
export function createWebServer({ engineForProject = getEngine, timeoutMs = 65_000, makeRunner = defaultMakeRunner, checkStore = defaultCheckStore, personaCatalog = PERSONA_CATALOG, distDir = DIST, llmSettings = createLlmSettings(), publicHost = process.env.GLINT_PUBLIC_HOST, accessToken = process.env.GLINT_ACCESS_TOKEN, authRequired = process.env.GLINT_PUBLIC_AUTH !== "0", mediaJobs = defaultMediaJobs } = {}) {
  if (publicHost && authRequired && (!accessToken || accessToken.length < 24)) throw new Error("Public hosting requires a strong GLINT_ACCESS_TOKEN");
  const jobs = makeRunner;
  let voicePreviewBusy = false;
  const personas=parsePersonaCatalog(personaCatalog);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { status: "ok" });
    const access = requestAccess(req, { publicHost, accessToken, authRequired });
    if (access.status !== 200) {
      if (access.status === 401) res.setHeader("www-authenticate", 'Basic realm="Glint", charset="UTF-8"');
      return sendJson(res, access.status, { error: access.status === 401 ? "Authentication required" : "Host not allowed" });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { status: "ok", service: "glint-web", version: process.env.GLINT_VERSION ?? "0.1.0", modelConfigured: Boolean(process.env.GLINT_LLM_API_KEY), voices: configuredVoiceEngines(), uptimeSeconds: Math.round(process.uptime()) });
    }
    if(req.method === "GET" && url.pathname === "/api/personas")return sendJson(res,200,personas);
    const libraryImage = url.pathname.match(/^\/assets\/([a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp))$/);
    if (libraryImage && req.method === "GET") {
      const file = mediaJobs.asset(libraryImage[1]);
      if (file) { res.writeHead(200, { "content-type": MIME[path.extname(file)], "content-length": fs.statSync(file).size, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" }); fs.createReadStream(file).pipe(res); return; }
    }
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
    if (url.pathname.startsWith("/api/settings/llm")) {
      if (req.method === "GET" && url.pathname === "/api/settings/llm") return sendJson(res, 200, llmSettings.read());
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 8000));
        if (url.pathname.endsWith("/models")) return sendJson(res, 200, await llmSettings.models(body, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])));
        if (url.pathname.endsWith("/test")) return sendJson(res, 200, await llmSettings.test(controller.signal));
        if (url.pathname !== "/api/settings/llm") return sendJson(res, 404, { error: "Unknown settings endpoint" });
        const result = llmSettings.save(body); engines.clear(); return sendJson(res, 200, result);
      } catch { if (!res.destroyed) return sendJson(res, 400, { error: "Model configuration failed. Check address, key, model and protocol; enter a key again when changing services." }); }
      finally { res.off("close", stop); }
      return;
    }
    if (url.pathname.startsWith("/api/media/")) {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (req.method === "GET" && url.pathname === "/api/media/library") return sendJson(res, 200, { assets: mediaJobs.library() });
        if (req.method === "GET" && url.pathname === "/api/media/models") {
          const type = url.searchParams.get("type"); if (!["audio", "image", "video"].includes(type)) return sendJson(res, 400, { error: "Unknown media type" });
          return sendJson(res, 200, { configured: mediaJobs.configured(), models: mediaJobs.configured() ? await mediaJobs.models(type) : [] });
        }
        if (req.method === "POST" && url.pathname === "/api/media/submit") return sendJson(res, 202, await mediaJobs.submit(JSON.parse(await readBody(req, controller.signal, 2 * 1024 * 1024)), controller.signal));
        const request = url.pathname.match(/^\/api\/media\/request\/([a-zA-Z0-9_-]{1,100})$/);
        if (request && req.method === "GET") {
          const record = mediaJobs.findRequest(request[1]);
          return sendJson(res, record ? 200 : 404, record ?? { error: "Submission receipt is unconfirmed; inspect the gateway before submitting again" });
        }
        const status = url.pathname.match(/^\/api\/media\/status\/([a-zA-Z0-9_-]{1,100})$/);
        if (status && req.method === "GET") return sendJson(res, 200, await mediaJobs.status(status[1], controller.signal));
        const asset = url.pathname.match(/^\/api\/media\/assets\/([^/]+)$/);
        if (asset && req.method === "GET") {
          const file = mediaJobs.asset(asset[1]); if (!file) return sendJson(res, 404, { error: "Asset not found" });
          const type = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" }[path.extname(file)];
          res.writeHead(200, { "content-type": type, "content-length": fs.statSync(file).size, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" }); fs.createReadStream(file).pipe(res); return;
        }
        return sendJson(res, 404, { error: "Unknown media endpoint" });
      } catch { if (!res.destroyed) sendJson(res, 400, { error: "Media request failed. Check gateway configuration and model parameters; do not resubmit an uncertain task." }); }
      finally { res.off("close", stop); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/edit-scene") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 300000)), project = parseProject(body.project);
        if (project.scenes.length > 30 || typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > 2000 || typeof body.sceneId !== "string") return sendJson(res, 400, { error: "Choose one scene and enter 1..2000 characters" });
        if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "Configure a text model first" });
        const edited = await reexplain(project, llmFromEnvironment(), { sceneId: body.sceneId, confusion: body.instruction, signal: controller.signal, timeoutMs: 60000 });
        return sendJson(res, 200, { project: edited });
      } catch { if (!res.destroyed) return sendJson(res, 400, { error: "Scene edit failed; the original project is unchanged" }); }
      finally { res.off("close", stop); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/voice-preview") {
      if (voicePreviewBusy) return sendJson(res, 429, { error: "Voice preview is busy" });
      voicePreviewBusy = true;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", stop);
      let provider;
      try {
        const input = JSON.parse(await readBody(req, controller.signal, 4000));
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 300 || (input.voice !== undefined && (typeof input.voice !== "string" || input.voice.length > 128)) || (input.speakingRate !== undefined && (!Number.isFinite(input.speakingRate) || input.speakingRate < 0.5 || input.speakingRate > 2))) return sendJson(res, 400, { error: "Preview requires 1..300 characters, valid voice and speed" });
        if (!configuredVoiceEngines().includes(input.engine) || input.engine === "mock") return sendJson(res, 400, { error: "Select a configured speech engine" });
        provider = createConfiguredTtsProvider(input.engine);
        const [audio] = await synthesizeBatch(provider, [{ text: input.text, voice: input.voice || undefined, speakingRate: input.speakingRate, signal: controller.signal }], { cacheDir: path.join(STUDIO_DIR, ".cache", "tts"), concurrency: 1, signal: controller.signal });
        if (!res.destroyed) { res.writeHead(200, { "content-type": audio.mimeType, "cache-control": "no-store", "content-length": audio.audio.length, "x-content-type-options": "nosniff" }); res.end(audio.audio); }
      } catch {
        if (!res.destroyed) sendJson(res, 502, { error: "Voice preview failed; check server voice configuration and provider availability" });
      } finally { provider?.dispose?.(); voicePreviewBusy = false; res.off("close", stop); }
      return;
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
          const llm = llmFromEnvironment();
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
  const host = process.env.GLINT_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && !process.env.GLINT_PUBLIC_HOST) throw new Error("Network binding requires GLINT_PUBLIC_HOST");
  createWebServer().listen(port, host, () => console.log(`[glint-web] serving ${DIST} on ${host}:${port}`));
}
