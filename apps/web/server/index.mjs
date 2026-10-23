import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnswerEngine, loadMarkdown, LexicalKnowledgeBase } from "@glintai/knowledge";
import { llmFromEnvironment } from "@glintai/llm";
import { TEMPLATES, composeFromMarkdown, composeFromSource, composeWithLlm, reviewProject } from "@glintai/composer";
import { instantiateCreationPack, listCreationPacks } from "@glintai/composer/creation-packs";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import { PERSONA_CATALOG, parsePersonaCatalog } from "@glintai/listener/catalog";
import { configuredVoiceEngines, createConfiguredTtsProvider, synthesizeBatch } from "@glintai/tts";
import { createJobRunner } from "./jobs.mjs";
import { createCheckStore } from "./checks.mjs";
import { createLlmSettings } from "./llm-settings.mjs";
import { reexplain } from "@glintai/listener";
import { requestAccess } from "./access.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { buildReferenceProjectFromVideo } from "./reference.mjs";
import { FileSessionStore, SessionStoreError } from "@glintai/session/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.GLINT_WEB_DIST ?? path.join(__dirname, "..", "dist");
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

const STUDIO_DIR = process.env.GLINT_STUDIO_DIR ?? path.join(__dirname, "..", "..", "studio");
const DATA_DIR = process.env.GLINT_DATA_DIR;
const MEDIA_SETTINGS_FILE = DATA_DIR ? path.join(DATA_DIR, "media-settings.json") : path.join(STUDIO_DIR, ".media-settings.json");
const LLM_SETTINGS_FILE = DATA_DIR ? path.join(DATA_DIR, "llm-settings.json") : undefined;
const defaultMediaSettings = createMediaSettings({ file: MEDIA_SETTINGS_FILE, env: process.env });
const mediaEnvironment = { ...process.env, ...(defaultMediaSettings.env().baseUrl ? { GLINT_MEDIA_BASE_URL: defaultMediaSettings.env().baseUrl, GLINT_MEDIA_API_KEY: defaultMediaSettings.env().apiKey, GLINT_MEDIA_PROTOCOL: defaultMediaSettings.env().protocol } : {}) };
const defaultMediaJobs = createMediaJobs(DATA_DIR ? path.join(DATA_DIR, "media") : path.join(STUDIO_DIR, "out", ".media"), mediaEnvironment);
const MAKE_ENTRY = process.env.GLINT_MAKE_ENTRY;
const defaultMakeRunner = createJobRunner({ studioDir: STUDIO_DIR, outputDir: DATA_DIR ? path.join(DATA_DIR, "jobs") : undefined, templates: TEMPLATES, musicAsset: name => defaultMediaJobs.asset(name),
  ...(MAKE_ENTRY ? { execPath: process.env.GLINT_MAKE_NODE ?? process.execPath, execArgs: [MAKE_ENTRY] } : {}) });
const defaultCheckStore = createCheckStore(DATA_DIR ? path.join(DATA_DIR, "checks") : path.join(STUDIO_DIR, "out", ".checks"));
const EXPORT_DIR = DATA_DIR ? path.join(DATA_DIR, "exports") : path.join(STUDIO_DIR, "out", "exports");
const EXPORT_ID = /^[a-f0-9]{16}$/;

/** Runs the existing CLI render command; it does not duplicate the renderer. */
function cliInvocation(args) {
  if (process.env.GLINT_CLI_ENTRY) return { execPath: process.env.GLINT_CLI_NODE ?? process.execPath, args: [process.env.GLINT_CLI_ENTRY, ...args] };
  const loader = pathToFileURL(createRequire(path.join(STUDIO_DIR, "package.json")).resolve("tsx")).href;
  return { execPath: process.execPath, args: ["--import", loader, path.join(STUDIO_DIR, "scripts", "glint.ts"), ...args] };
}

function exportProject({ project, format, frame, assetFor, signal }) {
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex");
    const directory = path.join(EXPORT_DIR, id);
    const output = path.join(directory, `${id}.${format}`);
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    try {
      fs.writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
      for (const scene of project.scenes) {
        if (scene.kind !== "image" && scene.kind !== "video") continue;
        const source = assetFor(scene.src.slice(7));
        if (!source) throw new Error("A media asset in this project is missing");
        fs.copyFileSync(source, path.join(directory, "assets", path.basename(scene.src)));
      }
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); reject(error); return; }
    const invocation = cliInvocation(["render", `--project=${path.join(directory, "project.json")}`, `--out=${output}`, `--format=${format}`, "--tts=mock", "--music=off", "--fast", ...(format === "png" ? [`--frame=${frame}`] : [])]);
    const child = spawn(invocation.execPath, invocation.args, { cwd: STUDIO_DIR, env: process.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false, signal });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); reject(new Error("Export timed out")); }, 180_000);
    child.once("error", error => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) resolve({ id, file: `${id}.${format}`, bytes: fs.statSync(output).size, url: `/api/project/export/${id}/${id}.${format}` });
      else { fs.rmSync(directory, { recursive: true, force: true }); reject(new Error(`Export failed (${code ?? "signal"}): ${stderr.slice(-300)}`)); }
    });
  });
}

function exportProjectNle({ project, format, assetFor, signal }) {
  return new Promise((resolve, reject) => {
    if (!["fcpxml", "edl"].includes(format)) { reject(new Error("NLE format must be fcpxml or edl")); return; }
    const id = randomBytes(8).toString("hex"), directory = path.join(EXPORT_DIR, id);
    const master = path.join(directory, `${id}.mp4`), output = path.join(directory, `${id}.${format}`);
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    try {
      fs.writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
      for (const scene of project.scenes) {
        if (scene.kind !== "image" && scene.kind !== "video") continue;
        const source = assetFor(scene.src.slice(7));
        if (!source) throw new Error("A media asset in this project is missing");
        fs.copyFileSync(source, path.join(directory, "assets", path.basename(scene.src)));
      }
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); reject(error); return; }
    const invocation = cliInvocation(["render", `--project=${path.join(directory, "project.json")}`, `--out=${master}`, "--format=mp4", "--tts=existing", `--music=${project.music ? "existing" : "off"}`]);
    const child = spawn(invocation.execPath, invocation.args, { cwd: STUDIO_DIR, env: process.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false, signal });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); reject(new Error("NLE export timed out")); }, 240_000);
    child.once("error", error => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.once("close", async code => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(master) || fs.statSync(master).size === 0) throw new Error(`Master render failed (${code ?? "signal"}): ${stderr.slice(-300)}`);
        const { probeVideo } = await import("../../studio/scripts/qa.ts");
        const { exportNleTimeline } = await import("../../studio/scripts/nle-export.ts");
        const spec = await probeVideo(master);
        const result = exportNleTimeline({ project, videoPath: master, format, outPath: output, spec });
        resolve({
          id, file: `${id}.${format}`, bytes: result.bytes, cuts: result.cuts, warning: result.warning,
          url: `/api/project/export/${id}/${id}.${format}`,
          master: { file: `${id}.mp4`, bytes: fs.statSync(master).size, url: `/api/project/export/${id}/${id}.mp4` },
        });
      } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); reject(error); }
    });
  });
}

function exportNleVideo({ project, assetFor, signal }) {
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex"), directory = path.join(EXPORT_DIR, id);
    const assets = path.join(directory, "assets"), output = path.join(directory, `${id}.mp4`);
    fs.mkdirSync(assets, { recursive: true });
    try {
      fs.writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
      const names = new Set();
      for (const track of project.tracks) for (const clip of track.clips) {
        if (clip.kind === "text") continue;
        names.add(clip.src.slice("assets/".length));
      }
      for (const name of names) {
        const source = assetFor(name);
        if (!source) throw new Error(`NLE asset is missing from the library: ${name}`);
        fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
        fs.copyFileSync(source, path.join(assets, name));
      }
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); reject(error); return; }
    const invocation = cliInvocation(["nle-render", `--project=${path.join(directory, "project.json")}`, `--assets=${assets}`, `--out=${output}`, "--encoding=balanced"]);
    const child = spawn(invocation.execPath, invocation.args, { cwd: STUDIO_DIR, env: process.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false, signal });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); reject(new Error("NLE render timed out")); }, 300_000);
    child.once("error", error => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) resolve({ id, file: `${id}.mp4`, bytes: fs.statSync(output).size, url: `/api/project/export/${id}/${id}.mp4` });
      else { fs.rmSync(directory, { recursive: true, force: true }); reject(new Error(`NLE render failed (${code ?? "signal"}): ${stderr.slice(-300)}`)); }
    });
  });
}

/** Injection keeps HTTP contract tests local and independent of API credentials. */
export function createWebServer({ deliveryChecker = async input => (await import("../../studio/scripts/delivery-check.ts")).checkDelivery(input), engineForProject = getEngine, nleExporter = exportProjectNle, nleVideoRenderer = exportNleVideo, timeoutMs = 65_000, makeRunner = defaultMakeRunner, studioProject = id => path.join(STUDIO_DIR, "out", `${id}.project.json`), checkStore = defaultCheckStore, personaCatalog = PERSONA_CATALOG, distDir = DIST, ttsCacheDir = path.join(process.env.GLINT_CACHE_DIR ?? path.join(STUDIO_DIR, ".cache"), "tts"), llmSettings = createLlmSettings(process.env, LLM_SETTINGS_FILE), publicHost = process.env.GLINT_PUBLIC_HOST, accessToken = process.env.GLINT_ACCESS_TOKEN, authRequired = process.env.GLINT_PUBLIC_AUTH !== "0", mediaJobs = defaultMediaJobs, mediaSettings = defaultMediaSettings, referenceBuilder = buildReferenceProjectFromVideo, sessionStore = new FileSessionStore(undefined, document => { parseProject(document); }) } = {}) {
  if (publicHost && authRequired && (!accessToken || accessToken.length < 24)) throw new Error("Public hosting requires a strong GLINT_ACCESS_TOKEN");
  const jobs = makeRunner;
  let voicePreviewBusy = false;
  let referenceBusy = false;
  const activeDeliveryChecks = new Set();
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
      // The desktop packager writes build.json next to the app root; the dev server reads the repo's dist copy when present.
      let build;
      for (const candidate of [process.env.GLINT_BUILD_FILE, path.join(DIST, "..", "build.json"), path.resolve(process.cwd(), "build.json"), path.join(DIST, "build.json")]) {
        if (!candidate) continue;
        try { build = JSON.parse(fs.readFileSync(candidate, "utf8")); if (build?.version) break; } catch { /* try next location */ }
      }
      return sendJson(res, 200, { status: "ok", service: "glint-web", version: process.env.GLINT_VERSION ?? build?.version ?? "0.1.0", modelConfigured: Boolean(process.env.GLINT_LLM_API_KEY), voices: configuredVoiceEngines(), uptimeSeconds: Math.round(process.uptime()), ...(build ? { build } : {}) });
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
    if (req.method === "GET" && url.pathname === "/api/creation-packs") {
      return sendJson(res, 200, { packs: listCreationPacks(url.searchParams.get("query") ?? "") });
    }
    if (url.pathname === "/api/creation-packs/instantiate") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST to instantiate a creation pack" });
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 32000));
        if (!body || typeof body.id !== "string") return sendJson(res, 400, { error: "Creation pack id is required" });
        const instance = instantiateCreationPack(body.id, body.inputs ?? {}, { aspect: body.aspect });
        return sendJson(res, 200, instance);
      } catch (error) { if (!res.destroyed) return sendJson(res, error.status === 413 ? 413 : 400, { error: "Invalid creation pack or inputs; check the selected pack fields" }); }
      finally { res.off("close", stop); }
      return;
    }
    if (url.pathname === "/api/settings/media") {
      if (req.method === "GET") return sendJson(res, 200, mediaSettings.read());
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", stop);
      try {
        if (req.method === "POST") {
          const saved = mediaSettings.save(JSON.parse(await readBody(req, controller.signal, 8192)));
          const effective = mediaSettings.env();
          mediaJobs.applyEnv?.({ GLINT_MEDIA_BASE_URL: effective.baseUrl, GLINT_MEDIA_API_KEY: effective.apiKey, GLINT_MEDIA_PROTOCOL: effective.protocol });
          return sendJson(res, 200, saved);
        }
        if (req.method === "DELETE") {
          const cleared = mediaSettings.clear();
          mediaJobs.applyEnv?.({ GLINT_MEDIA_BASE_URL: process.env.GLINT_MEDIA_BASE_URL, GLINT_MEDIA_API_KEY: process.env.GLINT_MEDIA_API_KEY, GLINT_MEDIA_PROTOCOL: process.env.GLINT_MEDIA_PROTOCOL ?? "skills" });
          return sendJson(res, 200, cleared);
        }
        return sendJson(res, 405, { error: "Use GET, POST or DELETE" });
      } catch (error) {
        // fs/JSON errors can carry absolute paths or a request snippet; keep them server-side.
        const unsafe = error instanceof SyntaxError || (error && typeof error.code === "string");
        return sendJson(res, 400, { error: unsafe ? "Media settings were not saved; check the settings file and JSON" : error instanceof Error ? error.message : "Media settings were not saved" });
      } finally { res.off("close", stop); }
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      try {
        const repoRoot = path.resolve(STUDIO_DIR, "..", ".."), skillsRoot = path.join(repoRoot, "skills");
        let lock = {};
        try { lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "skills-lock.json"), "utf8")).skills ?? {}; } catch { lock = {}; }
        // Installed skills are often junctions/symlinks (linked from a registry checkout);
        // readdir reports those as symlinks, so resolve them instead of silently hiding them.
        const isDirLike = entry => {
          if (entry.isDirectory()) return true;
          if (!entry.isSymbolicLink()) return false;
          try { return fs.statSync(path.join(skillsRoot, entry.name)).isDirectory(); } catch { return false; }
        };
        const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
          .filter(isDirLike).slice(0, 100)
          .flatMap(entry => {
            const file = path.join(skillsRoot, entry.name, "SKILL.md");
            try {
              if (!fs.statSync(file).isFile() || fs.statSync(file).size > 128 * 1024) return [];
              const text = fs.readFileSync(file, "utf8");
              const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
              const field = key => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
              return [{ id: entry.name, name: field("name") || entry.name, description: field("description"), path: `skills/${entry.name}/SKILL.md`, source: lock[entry.name]?.source ?? "local" }];
            } catch { return []; }
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        return sendJson(res, 200, { skills, scope: "local" });
      } catch { return sendJson(res, 200, { skills: [], scope: "local" }); }
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
    if (url.pathname.startsWith("/api/session")) {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const match = url.pathname.match(/^\/api\/session\/(open|list|snapshot|look|inspect|apply|verify|select|undo|redo)$/);
        if (!match) return sendJson(res, 404, { error: "Unknown session endpoint" });
        const action = match[1];
        if (req.method === "GET") {
          if (action === "list") return sendJson(res, 200, { projects: sessionStore.list() });
          if (!["look", "snapshot"].includes(action)) return sendJson(res, 405, { error: "Use POST for session operations" });
          const value = sessionStore.snapshot(url.searchParams.get("projectId"));
          return sendJson(res, 200, action === "look" ? value.look : value);
        }
        if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST for session operations" });
        const body = JSON.parse(await readBody(req, controller.signal, 300000));
        if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) return sendJson(res, 400, { error: "projectId is required" });
        if (action === "open") return sendJson(res, 200, sessionStore.open(body.projectId, body.project));
        if (action === "inspect") return sendJson(res, 200, sessionStore.inspect(body.projectId, body.path));
        if (action === "verify") {
          if (typeof body.transactionId !== "string") return sendJson(res, 400, { error: "transactionId is required" });
          const receipt = sessionStore.verify(body.projectId, body.transactionId);
          return sendJson(res, receipt.stage === "refused" ? 404 : 200, receipt);
        }
        if (action === "select") return sendJson(res, 200, sessionStore.select(body.projectId, body.handles));
        let value;
        if (action === "apply") {
          if (!body.transaction || typeof body.transaction !== "object") return sendJson(res, 400, { error: "transaction is required" });
          value = sessionStore.apply(body.projectId, body.transaction);
        } else if (action === "undo" || action === "redo") {
          value = sessionStore.historyEdit(body.projectId, action, body.transactionId, body.baseRevision, body.actor);
        } else return sendJson(res, 405, { error: "Use GET for readback" });
        return sendJson(res, value.receipt.stage === "refused" ? 409 : 200, { ...value, project: value.snapshot.document });
      } catch (error) {
        const status = error instanceof SessionStoreError ? error.code === "not-found" ? 404 : error.code === "busy" || error.code === "external-change" || error.code === "project-conflict" ? 409 : 500 : 400;
        if (!res.destroyed) return sendJson(res, status, { error: error instanceof Error ? error.message : "Session operation failed", code: error.code });
      } finally { res.off("close", stop); }
      return;
    }
    if (url.pathname.startsWith("/api/media/")) {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (req.method === "GET" && url.pathname === "/api/media/library") return sendJson(res, 200, { assets: mediaJobs.library() });
        if (req.method === "GET" && url.pathname === "/api/media/versions") return sendJson(res, 200, { versions: mediaJobs.versions() });
        if (req.method === "GET" && url.pathname === "/api/media/models") {
          const type = url.searchParams.get("type"); if (!["audio", "image", "video"].includes(type)) return sendJson(res, 400, { error: "Unknown media type" });
          return sendJson(res, 200, { configured: mediaJobs.configured(), protocol: mediaJobs.protocol?.() ?? "skills", models: mediaJobs.configured() ? await mediaJobs.models(type) : [] });
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
        if (asset && (req.method === "GET" || req.method === "HEAD")) {
          let name;
          try { name = decodeURIComponent(asset[1]); } catch { return sendJson(res, 404, { error: "Asset not found" }); }
          const file = mediaJobs.asset(name); if (!file) return sendJson(res, 404, { error: "Asset not found" });
          const type = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" }[path.extname(file)] ?? "application/octet-stream";
          const size = fs.statSync(file).size;
          const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" };
          const reject = () => { res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": "0" }); res.end(); };
          const range = req.headers.range;
          if (range === undefined) {
            res.writeHead(200, { ...headers, "content-length": String(size) });
            if (req.method === "HEAD" || size === 0) { res.end(); return; }
            const stream = fs.createReadStream(file);
            res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res); return;
          }
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (match[1] === "" && match[2] === "") || size === 0) return reject();
          let start, end;
          if (match[1] === "") {
            if (!/^\d+$/.test(match[2])) return reject();
            const suffix = Number(match[2]);
            if (!Number.isSafeInteger(suffix) || suffix === 0) return reject();
            start = suffix >= size ? 0 : size - suffix; end = size - 1;
          } else {
            start = Number(match[1]);
            if (!Number.isSafeInteger(start) || start >= size) return reject();
            if (match[2] === "") end = size - 1;
            else {
              end = Number(match[2]);
              if (!Number.isSafeInteger(end) || end < start) return reject();
              end = Math.min(end, size - 1);
            }
          }
          res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
          if (req.method === "HEAD") { res.end(); return; }
          const stream = fs.createReadStream(file, { start, end });
          res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res); return;
        }
        return sendJson(res, 404, { error: "Unknown media endpoint" });
      } catch { if (!res.destroyed) sendJson(res, 400, { error: "Media request failed. Check gateway configuration and model parameters; do not resubmit an uncertain task." }); }
      finally { res.off("close", stop); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/srt") {
      const controller = new AbortController();
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 1_000_000));
        const project = parseProject(body.project);
        const { buildProjectCues, formatSrt } = await import("../../studio/scripts/jianying.ts");
        return sendJson(res, 200, { name: `${project.id}.srt`, srt: formatSrt(buildProjectCues(project)) });
      } catch {
        return sendJson(res, 400, { error: "Cannot build subtitles from this project; check the storyboard and try again." });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/project/export") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 1_000_000));
        const format = body?.format;
        if (!["gif", "png"].includes(format)) return sendJson(res, 400, { error: "Export format must be gif or png" });
        const project = parseProject(body.project);
        if (project.scenes.length > 30 || JSON.stringify(project).length > 100_000) return sendJson(res, 400, { error: "Project is too large to export" });
        const frame = format === "png" ? Number(body.frame ?? 0) : 0;
        if (!Number.isInteger(frame) || frame < 0 || frame > 1_000_000) return sendJson(res, 400, { error: "Invalid frame" });
        return sendJson(res, 200, await exportProject({ project, format, frame, assetFor: name => mediaJobs.asset(name), signal: controller.signal }));
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "Export failed" });
      } finally { res.off("close", stop); }
    }
    if (req.method === "POST" && url.pathname === "/api/nle/render") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 500_000));
        if (JSON.stringify(body?.project ?? {}).length > 300_000) return sendJson(res, 400, { error: "NLE project is too large" });
        const project = parseNleProject(body.project);
        return sendJson(res, 200, await nleVideoRenderer({ project, assetFor: name => mediaJobs.asset(name), signal: controller.signal }));
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "NLE render failed" });
      } finally { res.off("close", stop); }
    }
    if (req.method === "POST" && url.pathname === "/api/nle/timeline") {
      try {
        const body = JSON.parse(await readBody(req, new AbortController().signal, 400_000));
        if (!["fcpxml", "edl"].includes(body?.format)) return sendJson(res, 400, { error: "NLE format must be fcpxml or edl" });
        const project = parseNleProject(body.project);
        const id = randomBytes(8).toString("hex"), directory = path.join(EXPORT_DIR, id);
        fs.mkdirSync(directory, { recursive: true });
        const output = path.join(directory, `${id}.${body.format}`);
        const { exportNleProjectTimeline } = await import("../../studio/scripts/nle-export.ts");
        const result = exportNleProjectTimeline({ project, format: body.format, outPath: output, assetPath: name => mediaJobs.asset(name) ?? path.join(directory, "assets", name) });
        return sendJson(res, 200, { file: `${id}.${body.format}`, bytes: result.bytes, clips: result.clips, textClips: result.textClips, audioClips: result.audioClips, warning: result.warning, url: `/api/project/export/${id}/${id}.${body.format}` });
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "NLE timeline export failed" });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/project/nle") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 1_000_000));
        const format = body?.format;
        if (!["fcpxml", "edl"].includes(format)) return sendJson(res, 400, { error: "NLE format must be fcpxml or edl" });
        const project = parseProject(body.project);
        if (project.scenes.length > 30 || JSON.stringify(project).length > 100_000) return sendJson(res, 400, { error: "Project is too large to export" });
        return sendJson(res, 200, await nleExporter({ project, format, assetFor: name => mediaJobs.asset(name), signal: controller.signal }));
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "NLE export failed" });
      } finally { res.off("close", stop); }
    }
    const exportFile = url.pathname.match(/^\/api\/project\/export\/([a-f0-9]{16})\/([a-f0-9]{16}\.(?:gif|png|mp4|fcpxml|edl))$/);
    if (exportFile && req.method === "GET") {
      const [, id, name] = exportFile;
      if (!EXPORT_ID.test(id) || !name.startsWith(`${id}.`)) { res.writeHead(404); return res.end("not found"); }
      const file = path.join(EXPORT_DIR, id, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
      const type = name.endsWith(".gif") ? "image/gif" : name.endsWith(".png") ? "image/png" : name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".fcpxml") ? "application/xml" : "text/plain";
      res.writeHead(200, { "content-type": type, "content-length": fs.statSync(file).size, "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/project/thumbnails") {
      const controller = new AbortController();
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 1_000_000));
        const project = parseProject(body.project);
        const [{ renderSceneSvg }, { buildTimeline, timelineToFrames }] = await Promise.all([
          import("../../studio/scripts/native-svg/index.ts"),
          import("@glintai/scenescript"),
        ]);
        const { entries } = timelineToFrames(buildTimeline(project), project.fps ?? 30);
        const thumbnails = {};
        for (const entry of entries) {
          // Browser-backed scenes already have real media thumbnails or cannot be
          // rasterized by the SVG renderer; leave them to the client fallback.
          if (["image", "video", "html", "three"].includes(entry.scene.kind)) continue;
          try {
            const frame = Math.min(15, Math.max(0, Math.floor(entry.duration * 0.35)));
            const svg = renderSceneSvg(project, entry.scene, frame, { width: 360, height: 203 });
            thumbnails[entry.scene.id] = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
          } catch { /* keep the type tile fallback */ }
        }
        return sendJson(res, 200, { thumbnails });
      } catch {
        return sendJson(res, 400, { error: "Cannot render scene thumbnails for this project." });
      }
    }    if (req.method === "POST" && url.pathname === "/api/reference/upload") {
      try {
        const name = `upload-${randomBytes(6).toString("hex")}.mp4`;
        const result = await mediaJobs.upload(req, name);
        return sendJson(res, 201, result);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        return sendJson(res, status, { error: error instanceof Error ? error.message : "Upload failed" });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/reference/build") {
      if (referenceBusy) return sendJson(res, 409, { error: "A reference analysis is already running; wait for it to finish" });
      referenceBusy = true;
      try {
        const body = JSON.parse(await readBody(req, new AbortController().signal, 4096));
        const result = await referenceBuilder({ name: body?.name, media: mediaJobs, dataDir: DATA_DIR });
        return sendJson(res, 200, result);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        return sendJson(res, status, { error: error instanceof Error ? error.message : "Reference analysis failed" });
      } finally { referenceBusy = false; }
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
        const [audio] = await synthesizeBatch(provider, [{ text: input.text, voice: input.voice || undefined, speakingRate: input.speakingRate, signal: controller.signal }], { cacheDir: ttsCacheDir, concurrency: 1, signal: controller.signal });
        if (!res.destroyed) { res.writeHead(200, { "content-type": audio.mimeType, "cache-control": "no-store", "content-length": audio.audio.length, "x-content-type-options": "nosniff" }); res.end(audio.audio); }
      } catch {
        if (!res.destroyed) sendJson(res, 502, { error: "Voice preview failed; check server voice configuration and provider availability" });
      } finally { provider?.dispose?.(); voicePreviewBusy = false; res.off("close", stop); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/plan") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "规划需要文本模型；请在「模型连接设置」配置后重试。" });
        const body = JSON.parse(await readBody(req, controller.signal, 20_000));
        const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 500) : "";
        if (!goal) return sendJson(res, 400, { error: "先写一句目标，例如“给新店开业做一条 15 秒竖屏宣传”。" });
        const { PLAN_SYSTEM, parsePlanReply } = await import("@glintai/composer/plan");
        const llm = llmFromEnvironment();
        const audience = typeof body.audience === "string" ? body.audience.trim().slice(0, 200) : "";
        const material = typeof body.material === "string" ? body.material.trim().slice(0, 3000) : "";
        const reply = await llm.chat({
          system: PLAN_SYSTEM,
          temperature: 0.7,
          timeoutMs: 120_000,
          signal: controller.signal,
          messages: [{ role: "user", content: `目标：${goal}
受众：${audience || "未指定"}
平台画幅：${body.platform === "9:16" || body.platform === "1:1" ? body.platform : "16:9"}
素材要点：${material || "无，按常识合理规划，不编造数据"}
时长预期：${Number(body.seconds) > 0 ? Math.min(120, Math.round(Number(body.seconds))) : 15} 秒` }],
        });
        return sendJson(res, 200, { plan: parsePlanReply(reply.text) });
      } catch (error) {
        if (res.destroyed) return;
        const message = error instanceof Error ? error.message : "规划失败";
        return sendJson(res, 400, { error: /JSON/.test(message) ? `模型回复无法解析为计划：${message}` : `规划失败：${message}` });
      } finally { res.off("close", stop); }
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
    const makeProject = url.pathname.match(/^\/api\/make\/(idea-[a-z0-9-]+)\/project$/);
    if (makeProject) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET for the composed project" });
      try {
        const file = studioProject(makeProject[1]);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "Composed project not found; it may have been cleaned up." });
        if (fs.statSync(file).size > 1_000_000) return sendJson(res, 413, { error: "Composed project is unexpectedly large" });
        return sendJson(res, 200, { project: JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch { return sendJson(res, 400, { error: "Composed project is unreadable; regenerate the video." }); }
    }
    if (makeStatus && req.method === "DELETE") {
      const cancelled = jobs.cancel(makeStatus[1]);
      if (!cancelled) return sendJson(res, 404, { error: "Job not cancellable" });
      return sendJson(res, 200, { cancelled: true });
    }
    const deliveryCheck = url.pathname.match(/^\/api\/delivery-check\/(idea-[a-z0-9-]+)$/);
    if (deliveryCheck) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST for delivery checks" });
      const id = deliveryCheck[1], file = jobs.videoFile(id);
      if (!file) return sendJson(res, 404, { error: "Completed video not found" });
      if (activeDeliveryChecks.has(id) || activeDeliveryChecks.size >= 1) return sendJson(res, 409, { error: "A delivery check is already running; wait for it to finish" });
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      activeDeliveryChecks.add(id);
      try {
        const report = await deliveryChecker({ videoPath: file, audio: "optional", signal: controller.signal });
        // Never send local paths, subprocess diagnostics or provider details to the browser.
        if (!res.destroyed) return sendJson(res, 200, { pass: report.pass, bytes: report.bytes, sha256: report.sha256, duration: report.duration,
          checks: report.checks.map(check => ({ name: check.name, pass: check.pass })) });
      } catch { if (!res.destroyed) return sendJson(res, 502, { error: "Delivery check failed; verify the local media tools and retry" }); }
      finally { activeDeliveryChecks.delete(id); res.off("close", stop); }
      return;
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
