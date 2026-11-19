import { handleNleRender } from "./nle-render-route.mjs";
import { nleMotionArgs } from "./nle-render-options.ts";
import { composeInputHash, readComposeCache, writeComposeCache } from "./compose-cache.mjs";
import { logApiRequest, sendJson, readBody, sendEvent } from "./index-http.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnswerEngine, loadMarkdown, LexicalKnowledgeBase, readSourceText } from "@glintai/knowledge";
import { llmFromEnvironment } from "@glintai/llm";
import { TEMPLATES, composeFromMarkdown, composeFromSource, composeWithLlm, reviewProject } from "@glintai/composer";
import { instantiateCreationPack, listCreationPacks } from "@glintai/composer/creation-packs";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import { PERSONA_CATALOG, parsePersonaCatalog } from "@glintai/listener/catalog";
import { configuredVoiceEngines, createConfiguredTtsProvider, synthesizeBatch } from "@glintai/tts";
import { createJobRunner, webRenderSceneError } from "./jobs.mjs";
import { createCheckStore } from "./checks.mjs";
import { createLlmSettings } from "./llm-settings.mjs";
import { createWorkspaceFeatureRoutes } from "./workspace-feature-routes.mjs";
import { modelSettingsFile } from "./model-settings-path.ts";
import { createProjectContainerRoutes } from "./project-container-routes.ts"; import { createComfyMediaRoutes } from "./comfyui-media-routes.mjs";
import { reexplain } from "@glintai/listener";
import { requestAccess } from "./access.mjs";
import { createMediaExecutionHost } from "./media-execution-host.mjs";
import { handleMediaSettings } from "./media-settings-routes.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createSkillRuntime } from "./skill-runtime.mjs";
import { buildReferenceProjectFromVideo, refreshReferenceFrames } from "./reference.mjs";
import { readWorkbook } from "./workbook.mjs";
import { cleanupStoppedRender, stopWindowsRenderTree } from "./nle-windows-stop.mjs";
import { proposeNleText } from "./nle-text-proposal.mjs";
import { analyzeNleAudioBeats } from "./nle-beat-analysis.mjs";
import { createLocalCutout } from "./local-cutout.mjs";
import { createLocalUpscale } from "./local-upscale.mjs";
import { createDesktopDownload } from "./desktop-download.mjs";
import { adoptLibraryVisual } from "../src/media-adoption.ts";
import { FileSessionStore, SessionStoreError } from "@glintai/session/node";
import { canonicalJson } from "@glintai/session";
import { handleStyleCatalog } from "./style-catalog.mjs";
import { createDesignExportRoute } from "./design-export-route.mjs";
import { ARTIFACT_BODY_LIMIT, proposeArtifact } from "./artifact-proposal.mjs";
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
const STUDIO_DIR = process.env.GLINT_STUDIO_DIR ?? path.join(__dirname, "..", "..", "studio");
const DATA_DIR = process.env.GLINT_DATA_DIR;
const MEDIA_SETTINGS_FILE = DATA_DIR ? path.join(DATA_DIR, "media-settings.json") : fs.existsSync(path.join(STUDIO_DIR, ".media-settings.json")) ? path.join(STUDIO_DIR, ".media-settings.json") : modelSettingsFile("media");
const LLM_SETTINGS_FILE = modelSettingsFile("llm");
const defaultMediaSettings = createMediaSettings({ file: MEDIA_SETTINGS_FILE, env: process.env });
const mediaEnvironment = { ...process.env, ...(defaultMediaSettings.env().baseUrl ? { GLINT_MEDIA_BASE_URL: defaultMediaSettings.env().baseUrl, GLINT_MEDIA_API_KEY: defaultMediaSettings.env().apiKey, GLINT_MEDIA_PROTOCOL: defaultMediaSettings.env().protocol } : {}) };
const defaultMediaJobs = createMediaJobs(DATA_DIR ? path.join(DATA_DIR, "media") : path.join(STUDIO_DIR, "out", ".media"), mediaEnvironment);
const defaultSkillRuntime = createSkillRuntime({ repoRoot: path.resolve(STUDIO_DIR, "..", ".."), dataDir: DATA_DIR ? path.join(DATA_DIR, "skills") : path.join(STUDIO_DIR, "out", ".skills"), env: process.env, parseProject });
const MAKE_ENTRY = process.env.GLINT_MAKE_ENTRY;
let defaultMakeRunner;
function getDefaultMakeRunner() {
  return defaultMakeRunner ??= createJobRunner({ studioDir: STUDIO_DIR, outputDir: DATA_DIR ? path.join(DATA_DIR, "jobs") : undefined, templates: TEMPLATES, musicAsset: name => defaultMediaJobs.asset(name),
    ...(MAKE_ENTRY ? { execPath: process.env.GLINT_MAKE_NODE ?? process.execPath, execArgs: [MAKE_ENTRY] } : {}) });
}
const defaultCheckStore = createCheckStore(DATA_DIR ? path.join(DATA_DIR, "checks") : path.join(STUDIO_DIR, "out", ".checks"));
const EXPORT_DIR = DATA_DIR ? path.join(DATA_DIR, "exports") : path.join(STUDIO_DIR, "out", "exports");
const EXPORT_ID = /^[a-f0-9]{16}$/;
// --- Approved-plan composition idempotency ---------------------------------
// /api/compose with a requestId must never bill the model twice for the same
// request: finished results are cached on disk (survives restarts), in-flight
// requests are shared between callers, and a dropped connection does NOT
// abort the model call — the client re-posts the same requestId and picks up
// the finished result instead of re-paying.
const COMPOSE_REQUEST_ID = /^[a-zA-Z0-9-]{8,80}$/;
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
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill();
      fs.rmSync(directory, { recursive: true, force: true });
      reject(new Error("Export timed out"));
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      fs.rmSync(directory, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0)
        resolve({
          id,
          file: `${id}.${format}`,
          bytes: fs.statSync(output).size,
          url: `/api/project/export/${id}/${id}.${format}`,
        });
      else {
        fs.rmSync(directory, { recursive: true, force: true });
        reject(new Error(`Export failed (${code ?? "signal"}): ${stderr.slice(-300)}`));
      }
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

function exportNleVideo({ project, assetFor, signal, alpha = false, motionSamples = 1, shutterAngle = 180 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("NLE render cancelled")); return; }
    const id = randomBytes(8).toString("hex"), directory = path.join(EXPORT_DIR, id);
    const ext = alpha ? "webm" : "mp4";
    const assets = path.join(directory, "assets"), output = path.join(directory, `${id}.${ext}`);
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
    const invocation = cliInvocation(["nle-render", `--project=${path.join(directory, "project.json")}`, `--assets=${assets}`, `--out=${output}`, "--encoding=balanced", ...nleMotionArgs(motionSamples, shutterAngle), ...(alpha ? ["--alpha"] : [])]);
    // Keep the CLI alive until cancellation can target its whole process tree.
    // AbortSignal passed to spawn would kill only the CLI, orphaning its worker.
    const child = spawn(invocation.execPath, invocation.args, { cwd: STUDIO_DIR, env: process.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    let stopped = "", forceTimer, treeStop = Promise.resolve(true), spawnError;
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) { child.kill(); return; }
      if (process.platform === "win32") {
        treeStop = stopWindowsRenderTree(child);
      } else {
        // Puppeteer's SIGINT handler closes its separately detached Chromium group.
        try { process.kill(-child.pid, "SIGINT"); } catch { child.kill("SIGINT"); }
        forceTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 3000);
      }
    };
    const abort = () => stop("NLE render cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("NLE render timed out"), 300_000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener("abort", abort); };
    if (signal?.aborted) abort();
    child.once("error", error => { spawnError = error; });
    child.once("close", async code => {
      cleanup();
      if (stopped) {
        try {
          const safe = await cleanupStoppedRender(directory, treeStop, dir => fs.rmSync(dir, { recursive: true, force: true }));
          reject(new Error(safe ? stopped : `${stopped}; process-tree cleanup unconfirmed, temporary output retained`));
        } catch (error) { reject(error); }
        return;
      }
      if (spawnError) { fs.rmSync(directory, { recursive: true, force: true }); reject(spawnError); return; }
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) {
        // DELIVER-03: nle-render also writes a cover still next to the video.
        const coverFile = path.join(directory, `${id}.cover.jpg`);
        resolve({ id, file: `${id}.${ext}`, bytes: fs.statSync(output).size, url: `/api/project/export/${id}/${id}.${ext}`, ...(fs.existsSync(coverFile) ? { coverUrl: `/api/project/export/${id}/${id}.cover.jpg` } : {}) });
      }
      else { fs.rmSync(directory, { recursive: true, force: true }); reject(new Error(`NLE render failed (${code ?? "signal"}): ${stderr.slice(-300)}`)); }
    });
  });
}

/** Injection keeps HTTP contract tests local and independent of API credentials. */
export function createWebServer({
  basePath = process.env.GLINT_WEB_BASE_PATH ?? "/",
  designExporter,
  designExportDir = path.join(DATA_DIR ?? path.join(STUDIO_DIR, "out"), "design-exports"),
  portableChapterHandler,
  deliveryChecker = async (input) =>
    (await import("../../studio/scripts/delivery-check.ts")).checkDelivery(input),
  engineForProject = getEngine,
  nleExporter = exportProjectNle,
  projectExporter = exportProject,
  nleVideoRenderer = exportNleVideo,
  timeoutMs = 65_000,
  makeRunner = getDefaultMakeRunner(),
  studioProject = (id) => path.join(STUDIO_DIR, "out", `${id}.project.json`),
  checkStore = defaultCheckStore,
  personaCatalog = PERSONA_CATALOG,
  distDir = DIST,
  ttsCacheDir = path.join(process.env.GLINT_CACHE_DIR ?? path.join(STUDIO_DIR, ".cache"), "tts"),
  llmSettings = createLlmSettings(process.env, LLM_SETTINGS_FILE),
  publicHost = process.env.GLINT_PUBLIC_HOST,
  accessToken = process.env.GLINT_ACCESS_TOKEN,
  authRequired = process.env.GLINT_PUBLIC_AUTH !== "0",
  mediaJobs = defaultMediaJobs,
  mediaSettings = defaultMediaSettings,
  skillRuntime = defaultSkillRuntime,
  referenceBuilder = buildReferenceProjectFromVideo,
  sourceReader = readSourceText,
  localCutout = createLocalCutout(),
  localUpscale = createLocalUpscale(),
  projectContainerStoreFactory,
  modelRegistryStore,
  mediaExecutionTransport,
  mediaExecutionDownload,
  taskReader,
  sessionStore = new FileSessionStore(undefined, (document) => {
    parseProject(document);
  }),
  composeCacheDir = DATA_DIR
    ? path.join(DATA_DIR, "compose-cache")
    : path.join(STUDIO_DIR, "out", ".compose-cache"),
  requestLogDir = DATA_DIR ? path.join(DATA_DIR, "logs") : path.join(STUDIO_DIR, "out", ".logs"),
} = {}) {
  if (typeof basePath !== "string" || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath))
    throw new Error("GLINT_WEB_BASE_PATH must be / or an absolute path ending in /");
  if (publicHost && authRequired && (!accessToken || accessToken.length < 24))
    throw new Error("Public hosting requires a strong GLINT_ACCESS_TOKEN");
  const jobs = makeRunner;
  // The execution media root is resolved lazily (first execution route hit): a
  // disabled media library must not be probed or created at server startup.
  const mediaExecution = createMediaExecutionHost({ jobs: mediaJobs, settings: mediaSettings, registryStore: modelRegistryStore, registryFile: path.join(path.dirname(LLM_SETTINGS_FILE), "model-registry.json"), root: () => mediaJobs.portableChapterRoot?.() ?? path.join(path.dirname(requestLogDir), "media-execution"), transport: mediaExecutionTransport, download: mediaExecutionDownload });
  const handleWorkspaceFeatures = createWorkspaceFeatureRoutes({
    registryFile: path.join(path.dirname(LLM_SETTINGS_FILE), "model-registry.json"),
    registryStore: mediaExecution.registry,
    taskReader,
    mediaDir: DATA_DIR ? path.join(DATA_DIR, "media") : path.join(STUDIO_DIR, "out", ".media"),
    renderStateDir: path.join(
      DATA_DIR ? path.join(DATA_DIR, "jobs") : path.join(STUDIO_DIR, "out"),
      ".jobs",
    ),
    llmSettings,
    onLlmSaved: () => engines.clear(),
    readBody,
    sendJson,
  });
  const clientDownload = createDesktopDownload(),
    handleProjectContainers = createProjectContainerRoutes(projectContainerStoreFactory),
    handleComfyMedia = createComfyMediaRoutes(mediaJobs);
  const handleDesignExport = createDesignExportRoute({
    outputDir: designExportDir,
    mediaAsset: (name) => mediaJobs.asset(name),
    exporter: designExporter,
  });
  let voicePreviewBusy = false;
  let referenceBusy = false;
  let imageImportBusy = false;
  let sourcePreviews = 0;
  let workbookBusy = false;
  let cutoutBusy = false;
  let upscaleBusy = false;
  let beatAnalysisBusy = false;
  const activeDeliveryChecks = new Set();
  const composeInflight = new Map();
  const personas=parsePersonaCatalog(personaCatalog);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // OPS-06 error location: one JSON line per API request (time, path, status, latency).
    const requestStarted = Date.now();
    res.on("finish", () => {
      if (!url.pathname.startsWith("/api/") || url.pathname === "/api/health") return;
      logApiRequest(requestLogDir, { at: new Date().toISOString(), method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - requestStarted });
    });
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { status: "ok" });
    const access = requestAccess(req, { publicHost, accessToken, authRequired });
    if (access.status !== 200) {
      if (access.status === 401) res.setHeader("www-authenticate", 'Basic realm="Glint", charset="UTF-8"');
      return sendJson(res, access.status, { error: access.status === 401 ? "Authentication required" : "Host not allowed" });
    }
    if (basePath !== "/") {
      const prefix = basePath.slice(0, -1);
      if (url.pathname === prefix && ["GET", "HEAD"].includes(req.method)) {
        res.writeHead(308, { location: `${basePath}${url.search}`, "cache-control": "no-store" }); res.end(); return;
      }
      if (!url.pathname.startsWith(basePath)) return sendJson(res, 404, { error: "Not found" });
      url.pathname = url.pathname.slice(prefix.length);
    }
    if (url.pathname === "/api/download/client/status" && req.method === "GET") return sendJson(res, 200, { available: clientDownload.available() });
    if (url.pathname === "/api/download/client") return clientDownload.handle(req, res);
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
    if (["POST", "PUT", "DELETE"].includes(req.method) && req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* Invalid origin. */ }
      if (!sameOrigin) return sendJson(res, 403, { error: "Cross-origin mutation rejected" });
    }
    if (await handleWorkspaceFeatures(req, res, url)) return;
    if (await mediaExecution.route(req, res, url, { readBody, sendJson })) return;
    if (await handleProjectContainers(req, res, url, { readBody, sendJson }) || await handleComfyMedia(req, res, url, { readBody, sendJson })) return;
    if (await handleDesignExport(req, res, url, { readBody, sendJson })) return;
    if (await handleStyleCatalog(req, res, url, { sampleDir: process.env.GLINT_STYLE_SAMPLE_DIR ?? path.resolve(STUDIO_DIR, "../../outputs/style-samples"), historyDir: path.join(DATA_DIR ?? path.join(STUDIO_DIR, "out"), "style-history"), readBody })) return;
    // Document proposals never write project files: the client previews the diff and applies it itself.
    if (req.method === "POST" && url.pathname === "/api/artifact/proposal") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const provider = process.env.GLINT_LLM_API_KEY ? llmFromEnvironment() : null;
        const body = JSON.parse(await readBody(req, controller.signal, ARTIFACT_BODY_LIMIT));
        const result = await proposeArtifact(body, provider, { signal: controller.signal });
        if (!res.destroyed) return sendJson(res, 200, { document: result.document, summary: result.summary });
      } catch (error) {
        if (!res.destroyed) sendJson(res, error?.status === 413 || error?.code === "too-large" ? 413 : error?.code === "provider-unavailable" ? 503 : 400,
          { error: error instanceof SyntaxError ? "请求数据无法读取，原文档未修改。" : error?.message ?? "文档提案未生成，原文档未修改。" });
      } finally { res.off("close", stop); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/creation-packs") {
      return sendJson(res, 200, { packs: listCreationPacks(url.searchParams.get("query") ?? "") });
    }
    if (req.method === "GET" && url.pathname === "/api/local-cutout") return sendJson(res, 200, { configured: localCutout.configured() });
    if (req.method === "GET" && url.pathname === "/api/local-upscale") return sendJson(res, 200, { configured: localUpscale.configured() });
    if (req.method === "POST" && url.pathname === "/api/local-upscale") {
      if (!localUpscale.configured()) return sendJson(res, 503, { error: "未配置本地 AI 超分。" });
      if (upscaleBusy) return sendJson(res, 429, { error: "本地 AI 超分正忙，请稍后重试。" });
      upscaleBusy = true;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(245_000)]);
        const data = JSON.parse(await readBody(req, signal, 5_592_500));
        if (typeof data?.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || data.base64.length > 5_592_408) return sendJson(res, 400, { error: "图片格式或大小无效。" });
        const result = await localUpscale.run(Buffer.from(data.base64, "base64"), signal);
        if (!res.destroyed) { res.writeHead(200, { "content-type": "image/png", "content-length": result.length, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(result); }
      } catch (error) { if (!res.destroyed) return sendJson(res, error?.status === 413 ? 413 : 400, { error: error instanceof Error ? error.message : "本地 AI 超分失败。" }); }
      finally { res.off("close", stop); upscaleBusy = false; }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/local-cutout") {
      if (!localCutout.configured()) return sendJson(res, 503, { error: "未配置本地智能抠图。" });
      if (cutoutBusy) return sendJson(res, 429, { error: "本地智能抠图正忙，请稍后重试。" });
      cutoutBusy = true;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]);
        const data = JSON.parse(await readBody(req, signal, 5_592_500));
        if (typeof data?.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || data.base64.length > 5_592_408) return sendJson(res, 400, { error: "图片格式或大小无效。" });
        const result = await localCutout.run(Buffer.from(data.base64, "base64"), signal);
        if (!res.destroyed) { res.writeHead(200, { "content-type": "image/png", "content-length": result.length, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(result); }
      } catch (error) { if (!res.destroyed) return sendJson(res, error?.status === 413 ? 413 : 400, { error: error instanceof Error ? error.message : "本地智能抠图失败。" }); }
      finally { res.off("close", stop); cutoutBusy = false; }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/source/preview") {
      if (sourcePreviews >= 2) return sendJson(res, 429, { error: "资料读取繁忙，请稍后重试。" });
      sourcePreviews++;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 5000));
        if (typeof body?.url !== "string" || body.url.length > 2000) return sendJson(res, 400, { error: "请输入公开的 HTTPS 链接。" });
        const parsed = new URL(body.url.trim());
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) return sendJson(res, 400, { error: "请输入不含账号密码的 HTTPS 链接。" });
        const text = await sourceReader({ url: parsed.href }, { httpsOnly: true, signal: controller.signal, timeoutMs: 20_000, publicDns: process.env.GLINT_SOURCE_PUBLIC_DNS === "1" });
        if (typeof text !== "string" || !text.trim()) return sendJson(res, 422, { error: "链接没有可提取的文字。" });
        if (text.length > 12000) return sendJson(res, 422, { error: "提取正文超过 12000 字，请先精简资料。" });
        if (!res.destroyed) return sendJson(res, 200, { text });
      } catch { if (!res.destroyed) return sendJson(res, 400, { error: "无法读取链接：请检查地址、访问权限和文件格式；仅支持公开 HTTPS 资源。" }); }
      finally { sourcePreviews--; res.off("close", stop); }
      return;
    }
    if (req.method === "POST" && ["/api/chapters/export-bundle", "/api/chapters/import-bundle", "/api/chapters/preview-bundle", "/api/chapters/commit-bundle"].includes(url.pathname)) {
      // The host must explicitly inject an authenticated handler; never infer trust
      // from loopback, headers, or a Tauri window label.
      if (portableChapterHandler && await portableChapterHandler(req, res, url, { media: mediaJobs, sendJson })) return;
      return sendJson(res, 503, { error: "含素材章节包暂不可用：安全前置条件尚未满足。请使用章节引用 JSON 备份。" });
    }
    if (req.method === "POST" && url.pathname === "/api/source/workbook") {
      if (workbookBusy) return sendJson(res, 429, { error: "工作簿读取繁忙，请稍后重试。" });
      workbookBusy = true;
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const data = JSON.parse(await readBody(req, signal, 3 * 1024 * 1024));
        if (typeof data?.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || data.base64.length > 2796204) return sendJson(res, 400, { error: "工作簿格式或大小无效。" });
        const sheets = await readWorkbook(Buffer.from(data.base64, "base64"), signal);
        if (!res.destroyed) return sendJson(res, 200, { sheets });
      } catch { if (!res.destroyed) return sendJson(res, 400, { error: "无法读取 XLSX：请检查文件、缓存公式值和 Python 3 是否可用。" }); }
      finally { workbookBusy = false; res.off("close", stop); }
      return;
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
    if (await handleMediaSettings(req, res, url, { settings: mediaSettings, jobs: mediaJobs, readBody, sendJson })) return;
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
    if (req.method === "GET" && url.pathname === "/api/skills/runs") return sendJson(res, 200, { runs: skillRuntime.receipts() });
    if (req.method === "POST" && url.pathname === "/api/skills/run") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 256 * 1024));
        const receipt = await skillRuntime.run(body);
        return sendJson(res, receipt.ok ? 200 : 409, receipt);
      } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid skill run request" }); }
      finally { res.off("close", stop); }
    }
    if (url.pathname.startsWith("/api/session")) {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const match = url.pathname.match(/^\/api\/session\/(open|list|snapshot|look|inspect|apply|verify|select|undo|redo|approve-character|approve-product|adopt-reference-candidate)$/);
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
        if (action === "open") {
          if (body.createOnly !== undefined && typeof body.createOnly !== "boolean") return sendJson(res, 400, { error: "createOnly must be boolean" });
          return sendJson(res, 200, sessionStore.open(body.projectId, body.project, undefined, body.createOnly === true));
        }
        if (action === "inspect") return sendJson(res, 200, sessionStore.inspect(body.projectId, body.path));
        if (action === "verify") {
          if (typeof body.transactionId !== "string") return sendJson(res, 400, { error: "transactionId is required" });
          const receipt = sessionStore.verify(body.projectId, body.transactionId);
          return sendJson(res, receipt.stage === "refused" ? 404 : 200, receipt);
        }
        if (action === "select") return sendJson(res, 200, sessionStore.select(body.projectId, body.handles));
        if (action === "approve-character" || action === "approve-product") {
          const kind = action === "approve-character" ? "character" : "product";
          if (typeof body.assetId !== "string" || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(body.assetId) || typeof body.transactionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.transactionId) || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) throw new Error("批准请求无效。");
          const result = sessionStore.approveAsset(body.projectId, { id: body.transactionId, baseRevision: body.baseRevision, actor: "user", scope: {}, intent: `批准${kind === "character" ? "角色" : "商品"} ${body.assetId}` }, document => {
            const project = parseProject(document), index = project.assets?.findIndex(item => item.id === body.assetId) ?? -1;
            const asset = index >= 0 ? project.assets[index] : null;
            if (project.frozen || !asset || asset.kind !== kind || asset.approval) throw new Error("资产不可批准；请同步工程并检查类型和冻结状态。");
            if (!asset.name.trim() || !asset.description?.trim() || (kind === "character" && !asset.voice?.trim()) || asset.refs?.length !== 1 || !/^assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(asset.refs[0])) throw new Error(kind === "character" ? "批准前需填写描述、角色音色和一张素材库图片。" : "批准前需填写商品描述和一张素材库图片。");
            const pinned = mediaJobs.pinReference(asset.refs[0].slice("assets/".length)), refs = [`assets/${pinned.name}`];
            const approval = { version: asset.version, name: asset.name, description: asset.description, ...(asset.voice ? { voice: asset.voice } : {}), refs, refSha256: pinned.sha256 };
            return [{ kind: "set", path: ["assets", String(index)], value: { ...asset, refs, approval } }];
          });
          return sendJson(res, result.receipt.stage === "refused" ? 409 : 200, { ...result, project: result.snapshot.document });
        }
        if (action === "adopt-reference-candidate") {
          if (typeof body.transactionId !== "string" || typeof body.taskId !== "string" || !["replace", "insert"].includes(body.mode) || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) throw new Error("候选采用请求无效。");
          const result = sessionStore.applyTransform(body.projectId, { id: body.transactionId, baseRevision: body.baseRevision, actor: "user", scope: {}, intent: `采用参考图候选 ${body.taskId} ${body.mode}` }, document => {
            const binding = mediaJobs.referenceCandidate(body.taskId);
            const project = parseProject(document), scene = project.scenes.find(item => item.id === binding.sceneId);
            if (binding.projectId !== project.id || !scene || project.frozen) throw new Error("任务或镜头与当前工程不符。");
            const assets = (scene.assetRefs ?? []).map(ref => project.assets.find(item => item.id === ref.assetId));
            if (canonicalJson({ projectId: project.id, aspect: project.aspect, scene, assets }) !== binding.basis) throw new Error("镜头或引用资产已变化，候选未采用。");
            const approved = assets.find(item => item?.id === binding.assetId && ["character", "product"].includes(item.kind) && item.approval);
            if (!approved || approved.approval.refSha256 !== binding.sha256 || approved.approval.refs[0] !== `assets/${binding.referenceImage}`) throw new Error("参考图批准记录已变化。");
            mediaJobs.verifyReference(binding.referenceImage, binding.sha256);
            // 采用已校验的字节副本，不依赖候选原名；副本仍可能被外部进程修改。
            const adopted = mediaJobs.adoptCandidate(binding.candidateBytes, binding.candidate.split(".").pop());
            const next = adoptLibraryVisual(project, binding.sceneId, adopted.name, body.mode, `media-${randomBytes(16).toString("hex")}`);
            return [{ kind: "set", path: ["scenes"], value: next.scenes }];
          });
          return sendJson(res, result.receipt.stage === "refused" ? 409 : 200, { ...result, project: result.snapshot.document });
        }
        let value;
        if (action === "apply") {
          if (!body.transaction || typeof body.transaction !== "object") return sendJson(res, 400, { error: "transaction is required" });
          value = sessionStore.apply(body.projectId, body.transaction);
        } else if (action === "undo" || action === "redo") {
          value = sessionStore.historyEdit(body.projectId, action, body.transactionId, body.baseRevision, body.actor);
        } else return sendJson(res, 405, { error: "Use GET for readback" });
        return sendJson(res, value.receipt.stage === "refused" ? 409 : 200, { ...value, project: value.snapshot.document });
      } catch (error) {
        const status = error instanceof SessionStoreError ? error.code === "not-found" ? 404 : ["busy", "external-change", "project-conflict", "untrusted-import"].includes(error.code) ? 409 : 500 : 400;
        if (!res.destroyed) return sendJson(res, status, { error: error instanceof Error ? error.message : "Session operation failed", code: error.code });
      } finally { res.off("close", stop); }
      return;
    }
    if (url.pathname.startsWith("/api/media/")) {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (req.method === "GET" && url.pathname === "/api/media/library") return sendJson(res, 200, { assets: mediaJobs.library() });
        if (req.method === "POST" && url.pathname === "/api/media/import-image") {
          if (imageImportBusy) return sendJson(res, 503, { error: "An image is already being imported" });
          imageImportBusy = true;
          try {
            const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
            const result = await mediaJobs.uploadImage(req, type, controller.signal);
            return sendJson(res, 201, { ...result, url: `/api/media/assets/${result.name}` });
          } finally { imageImportBusy = false; }
        }
        if (req.method === "GET" && url.pathname === "/api/media/versions") return sendJson(res, 200, { versions: mediaJobs.versions() });
        if (req.method === "GET" && url.pathname === "/api/media/models") {
          const type = url.searchParams.get("type"); if (!["audio", "image", "video"].includes(type)) return sendJson(res, 400, { error: "Unknown media type" });
          return sendJson(res, 200, { configured: mediaJobs.configured(), protocol: mediaJobs.protocol?.() ?? "skills", models: mediaJobs.configured() ? await mediaJobs.models(type) : [] });
        }
        const pricing = url.pathname.match(/^\/api\/media\/pricing\/([a-zA-Z0-9_.\/-]{1,160})$/);
        if (pricing && req.method === "GET") {
          if (!mediaJobs.configured()) return sendJson(res, 503, { error: "Configure a media gateway first" });
          try { return sendJson(res, 200, await mediaJobs.pricing(decodeURIComponent(pricing[1]), controller.signal)); }
          catch { return sendJson(res, 502, { error: "Price card unavailable for this model; treat the cost estimate as unknown" }); }
        }
        if (req.method === "POST" && url.pathname === "/api/media/submit") {
          const input = JSON.parse(await readBody(req, controller.signal, 2 * 1024 * 1024));
          // Only a durable, approved and shot-bound identity can contribute a reference.
          // Do not accept an arbitrary local file path from the browser.
          delete input.referenceImage; delete input.referenceSha256; delete input.referenceBinding;
          if ([input.canvasReference, input.reference, input.libraryReference].filter(value => value !== undefined).length > 1) throw new Error("Choose only one reference source");
          if (input.canvasReference !== undefined && (!input.canvasReference || typeof input.canvasReference !== "object" || typeof input.canvasReference.taskId !== "string" || typeof input.canvasReference.sha256 !== "string")) throw new Error("Invalid canvas reference receipt");
          if (input.libraryReference !== undefined) {
            const ref = input.libraryReference;
            if (!ref || typeof ref !== "object" || typeof ref.name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(ref.name) || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")) throw new Error("Invalid library reference");
            mediaJobs.verifyReference(ref.name, ref.sha256);
            input.referenceImage = ref.name; input.referenceSha256 = ref.sha256;
            delete input.libraryReference;
          }
          if (input.reference) {
            const { projectId, sceneId, assetId, basis } = input.reference;
            if (typeof projectId !== "string" || typeof sceneId !== "string" || typeof assetId !== "string" || typeof basis !== "string") throw new Error("Invalid reference request");
            const project = parseProject(sessionStore.snapshot(projectId).snapshot.document);
            if (project.frozen) return sendJson(res, 400, { error: "工程已冻结，无法采用参考候选；请先解除冻结再提交任务。" });
            const scene = project.scenes.find(item => item.id === sceneId);
            if (!scene || scene.locked) throw new Error("Reference shot is unavailable or locked");
            const assets = (scene.assetRefs ?? []).map(ref => project.assets.find(item => item.id === ref.assetId));
            if (canonicalJson({ projectId: project.id, aspect: project.aspect, scene, assets }) !== basis) throw new Error("镜头或资产已变化，请同步工程后重新确认。");
            const character = assets.find(item => item?.id === assetId && ["character", "product"].includes(item.kind) && item.approval);
            const ref = character?.approval?.refs?.[0], sha256 = character?.approval?.refSha256;
            if (!sha256) throw new Error("旧批准未绑定图片内容；请新建版本并重新批准后使用参考图。");
            if (!ref || !/^assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(ref)) throw new Error("请选择已批准且绑定镜头的素材库角色参考图。");
            input.referenceImage = ref.slice("assets/".length); input.referenceSha256 = sha256;
            input.referenceBinding = { projectId, sceneId, assetId, basis, referenceImage: input.referenceImage, sha256 };
            delete input.reference;
          }
          return sendJson(res, 202, await mediaJobs.submit(input, controller.signal));
        }
        const request = url.pathname.match(/^\/api\/media\/request\/([a-zA-Z0-9_-]{1,100})$/);
        if (request && req.method === "GET") {
          const record = mediaJobs.findRequest(request[1]);
          return sendJson(res, record ? 200 : 404, record ?? { error: "Submission receipt is unconfirmed; inspect the gateway before submitting again" });
        }
        const status = url.pathname.match(/^\/api\/media\/status\/([a-zA-Z0-9_-]{1,100})$/);
        if (status && req.method === "GET") return sendJson(res, 200, await mediaJobs.status(status[1], controller.signal));
        const cancel = url.pathname.match(/^\/api\/media\/cancel\/([a-zA-Z0-9_-]{1,100})$/);
        if (cancel && req.method === "POST") {
          const outcome = await mediaJobs.cancel(cancel[1]);
          return sendJson(res, outcome ? 200 : 409, outcome ?? { error: "Task cannot be cancelled (unknown or already final)" });
        }
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
        const unsafeScene = webRenderSceneError(project);
        if (unsafeScene) return sendJson(res, 400, { error: unsafeScene });
        const frame = format === "png" ? Number(body.frame ?? 0) : 0;
        if (!Number.isInteger(frame) || frame < 0 || frame > 1_000_000) return sendJson(res, 400, { error: "Invalid frame" });
        return sendJson(res, 200, await projectExporter({ project, format, frame, assetFor: name => mediaJobs.asset(name), signal: controller.signal }));
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "Export failed" });
      } finally { res.off("close", stop); }
    }
    if (await handleNleRender(req, res, url, { renderer: nleVideoRenderer, assetFor: name => mediaJobs.asset(name), readBody, sendJson })) return;
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
        const unsafeScene = webRenderSceneError(project);
        if (unsafeScene) return sendJson(res, 400, { error: unsafeScene });
        return sendJson(res, 200, await nleExporter({ project, format, assetFor: name => mediaJobs.asset(name), signal: controller.signal }));
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "NLE export failed" });
      } finally { res.off("close", stop); }
    }
    const exportFile = url.pathname.match(/^\/api\/project\/export\/([a-f0-9]{16})\/([a-f0-9]{16}\.(?:gif|png|jpg|mp4|webm|fcpxml|edl|cover\.jpg))$/);
    if (exportFile && req.method === "GET") {
      const [, id, name] = exportFile;
      if (!EXPORT_ID.test(id) || !name.startsWith(`${id}.`)) { res.writeHead(404); return res.end("not found"); }
      const file = path.join(EXPORT_DIR, id, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
      const type = name.endsWith(".gif") ? "image/gif" : name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".webm") ? "video/webm" : name.endsWith(".fcpxml") ? "application/xml" : "text/plain";
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
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 4096));
        if (body?.ocr !== undefined && typeof body.ocr !== "boolean") return sendJson(res, 400, { error: "OCR option must be boolean" });
        const result = await referenceBuilder({ name: body?.name, media: mediaJobs, dataDir: DATA_DIR, signal: controller.signal, ocr: body?.ocr === true });
        if (!res.destroyed) return sendJson(res, 200, result);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        if (!res.destroyed) return sendJson(res, status, { error: error instanceof Error ? error.message : "Reference analysis failed" });
      } finally { res.off("close", stop); referenceBusy = false; }
    }
    if (req.method === "POST" && url.pathname === "/api/reference/frames") {
      if (referenceBusy) return sendJson(res, 409, { error: "已有参考分析或抽帧在运行。" });
      referenceBusy = true;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 4096));
        const result = await refreshReferenceFrames({ name: body?.name, sha256: body?.sha256, times: body?.times, media: mediaJobs, dataDir: DATA_DIR, signal: controller.signal });
        if (!res.destroyed) return sendJson(res, 200, result);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        if (!res.destroyed) return sendJson(res, status, { error: error instanceof Error ? error.message : "参考帧抽取失败。" });
      } finally { res.off("close", stop); referenceBusy = false; }
    }
    // AUDIO-03: server-side ASR (audio bytes arrive in the JSON body; the
    // browser cannot hold the LLM key, so transcription runs here).
    if (req.method === "POST" && url.pathname === "/api/audio/transcribe") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "转写需要文本模型；请在「模型连接设置」配置后重试。" });
        const body = JSON.parse(await readBody(req, controller.signal, 30_000_000));
        if (!body.audioBase64 || typeof body.audioBase64 !== "string" || body.audioBase64.length > 20_000_000) return sendJson(res, 400, { error: "缺少音频数据或超过 15MB 上限" });
        const format = body.format === "wav" ? "wav" : "mp3";
        const durationMs = Number(body.durationMs);
        if (!Number.isFinite(durationMs) || durationMs < 200 || durationMs > 3_600_000) return sendJson(res, 400, { error: "durationMs 无效" });
        const { transcribeAudio } = await import("@glintai/composer/asr");
        const transcript = await transcribeAudio({ audio: new Uint8Array(Buffer.from(body.audioBase64, "base64")), format, durationMs, model: process.env.GLINT_ASR_MODEL ?? "gem-3.8-flash", client: llmFromEnvironment(), diarize: body.diarize === true, signal: controller.signal });
        return sendJson(res, 200, transcript);
      } catch (error) { return sendJson(res, 500, { error: error instanceof Error ? error.message : "转写失败" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/nle/beats") {
      if (beatAnalysisBusy) return sendJson(res, 429, { error: "音频节拍分析正在运行，请稍后重试。" });
      beatAnalysisBusy = true;
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 4096));
        const result = await analyzeNleAudioBeats({ name: body?.name, startMs: body?.startMs, durationMs: body?.durationMs, media: mediaJobs, signal: controller.signal });
        if (!res.destroyed) return sendJson(res, 200, result);
      } catch (error) {
        if (!res.destroyed) return sendJson(res, Number.isInteger(error?.status) ? error.status : 400, { error: error instanceof Error ? error.message : "音频节拍分析失败。" });
      } finally { res.off("close", stop); beatAnalysisBusy = false; }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/nle/text-proposal") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "请先配置文本模型。" });
        const body = JSON.parse(await readBody(req, controller.signal, 300_000));
        const project = await proposeNleText(body.project, body.instruction, llmFromEnvironment(), controller.signal);
        if (!res.destroyed) return sendJson(res, 200, { project });
      } catch { if (!res.destroyed) return sendJson(res, 400, { error: "文字提案未生成，原工程未修改。" }); }
      finally { res.off("close", stop); }
      return;
    }
    // Multi-step agent: plan first (which scenes, in what order),
    // then the client executes each step through /api/edit-scene and expands the log.
    if (req.method === "POST" && url.pathname === "/api/assistant/plan") {
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
      try {
        if (!process.env.GLINT_LLM_API_KEY) return sendJson(res, 503, { error: "需要文本模型；请先在「模型连接设置」配置。" });
        const body = JSON.parse(await readBody(req, controller.signal, 200_000));
        const project = parseProject(body.project);
        if (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > 2000) return sendJson(res, 400, { error: "指令需要 1..2000 字符" });
        const llm = llmFromEnvironment();
        const sceneList = project.scenes.map(scene => `${scene.id}（${scene.kind}）：${scene.narration.text.slice(0, 40)}`).join("\n");
        const response = await llm.chat({
          system: "你是剪辑助手规划器。根据用户指令与镜头清单，产出执行计划 JSON：{\"steps\":[{\"sceneId\":\"…\",\"action\":\"≤40字的该镜头具体修改动作\"}]}。规则：只引用清单里存在的 sceneId；1-5 步；不需要修改的镜头不进计划；只输出 JSON。",
          json: true, temperature: 0.2, timeoutMs: 45_000, signal: controller.signal,
          messages: [{ role: "user", content: `指令：${body.instruction}
镜头清单：
${sceneList}` }],
        });
        const text = response.text;
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        const steps = Array.isArray(json.steps) ? json.steps.filter(step => step && typeof step.sceneId === "string" && project.scenes.some(scene => scene.id === step.sceneId) && typeof step.action === "string").slice(0, 5) : [];
        if (!steps.length) return sendJson(res, 200, { steps: [] });
        return sendJson(res, 200, { steps });
      } catch (error) { return sendJson(res, 500, { error: error instanceof Error ? error.message : "计划失败" }); }
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
        const budgetCny = Number.isFinite(body.budgetCny) && body.budgetCny >= 0 ? Math.min(Number(body.budgetCny), 1_000_000_000) : undefined;
        const reply = await llm.chat({
          system: PLAN_SYSTEM,
          temperature: 0.7,
          timeoutMs: 120_000,
          signal: controller.signal,
          messages: [{ role: "user", content: `目标：${goal}
受众：${audience || "未指定"}
预算参考：${budgetCny === undefined ? "未指定；低成本优先，不承诺精确报价" : `${budgetCny}元总预算（规划约束，不是报价）`}
平台画幅：${body.platform === "9:16" || body.platform === "1:1" ? body.platform : "16:9"}
素材要点：${material || "无，按常识合理规划，不编造数据"}
时长预期：${Number(body.seconds) > 0 ? Math.min(120, Math.round(Number(body.seconds))) : 15} 秒` }],
        });
        const plan = parsePlanReply(reply.text);
        return sendJson(res, 200, { plan: budgetCny === undefined ? plan : { ...plan, budgetCny } });
      } catch (error) {
        if (res.destroyed) return;
        const message = error instanceof Error ? error.message : "规划失败";
        return sendJson(res, 400, { error: /JSON/.test(message) ? `模型回复无法解析为计划：${message}` : `规划失败：${message}` });
      } finally { res.off("close", stop); }
    }
    const composeLookup = url.pathname.match(/^\/api\/compose\/request\/([a-zA-Z0-9-]{8,80})$/);
    if (composeLookup && req.method === "GET") {
      const id = composeLookup[1];
      if (composeInflight.has(id)) return sendJson(res, 200, { status: "running" });
      const cached = readComposeCache(composeCacheDir, id, undefined);
      if (cached?.body) return sendJson(res, 200, { status: "succeeded", body: cached.body, cached: true });
      if (cached?.mismatch) return sendJson(res, 200, { status: "succeeded", mismatchedInput: true });
      return sendJson(res, 404, { error: "No compose result for this request. Retry lookup before submitting again." });
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
        const requestId = body.requestId;
        if (requestId !== undefined && (typeof requestId !== "string" || !COMPOSE_REQUEST_ID.test(requestId))) return sendJson(res, 400, { error: "requestId must be 8-80 letters, digits or hyphens" });
        // An idempotent run must survive a dropped connection: the model call
        // gets its own signal, never the request's. Without a requestId the
        // historical behaviour (disconnect aborts) is kept unchanged.
        const taskSignal = requestId ? new AbortController().signal : controller.signal;
        const composeOnce = async () => {
          if ([Boolean(source), Boolean(idea), body.plan !== undefined].filter(Boolean).length !== 1) throw Object.assign(new Error("Choose source, idea or plan"), { status: 400 });
          if (body.plan !== undefined) {
            const { VideoPlan, planToSource } = await import("@glintai/composer/plan");
            const plan = VideoPlan.parse(body.plan);
            if (!process.env.GLINT_LLM_API_KEY) throw Object.assign(new Error("请先配置文本模型，再将分镜制作成工程。"), { status: 503 });
            const project = await composeWithLlm(planToSource(plan), llmFromEnvironment(), { projectId: `plan-${randomBytes(8).toString("hex")}` }, { signal: taskSignal, approvedPlan: plan });
            const basis = planToSource(plan);
            return { project, source: basis, generatedSource: false, review: reviewProject(project, basis) };
          }
          // "auto" keeps a one-line request free to become an ad, a mood piece or a demo.
          // Only an explicitly chosen template may constrain the narrative with bodyKinds.
          const templateId = body.template === "auto" ? undefined : body.template ?? "explainer";
          const options = { projectId: `editor-${randomBytes(8).toString("hex")}`, theme: body.theme ?? "glint-dark", aspect: body.aspect ?? "16:9", ...(templateId ? { template: templateId } : {}) };
          let project, basis = source;
          if (idea || body.engine === "llm") {
            if (!process.env.GLINT_LLM_API_KEY) throw Object.assign(new Error("Configure GLINT_LLM_API_KEY to use model composition"), { status: 503 });
            const llm = llmFromEnvironment();
            if (idea) {
              const composed = await composeFromSource({ idea }, llm, options, { signal: taskSignal });
              project = composed.project; basis = composed.sourceText;
            } else project = await composeWithLlm(source, llm, options, { signal: taskSignal });
          } else project = composeFromMarkdown(source, options);
          return { project, source: basis, generatedSource: Boolean(idea), review: reviewProject(project, basis) };
        };
        const reply = (status, payload) => { if (!res.destroyed) return sendJson(res, status, payload); };
        if (!requestId) return sendJson(res, 200, await composeOnce());
        const inputHash = composeInputHash(body);
        const cached = readComposeCache(composeCacheDir, requestId, inputHash);
        if (cached?.mismatch) return reply(409, { error: "该 requestId 已绑定不同的分镜内容；请修改内容并重试，会自动使用新的 requestId。" });
        if (cached?.body) return reply(200, { ...cached.body, cached: true });
        const inflight = composeInflight.get(requestId);
        if (inflight) {
          if (inflight.inputHash !== inputHash) return reply(409, { error: "该 requestId 已绑定不同的分镜内容；请修改内容并重试，会自动使用新的 requestId。" });
          return reply(200, await inflight.task);
        }
        const task = composeOnce().then(result => { writeComposeCache(composeCacheDir, requestId, inputHash, result); composeInflight.delete(requestId); return result; }, error => { composeInflight.delete(requestId); throw error; });
        composeInflight.set(requestId, { inputHash, task });
        return reply(200, await task);
      } catch (error) { if (!res.destroyed) return sendJson(res, error.status ?? 400, { error: error instanceof Error ? error.message : "Composition/review failed. Check source structure, template requirements and model configuration." }); }
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
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= size
        ) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          return res.end();
        }
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
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

// A bundled desktop service contains this module but owns its own entrypoint.
// Without the build-time guard both modules have the same import.meta.url.
if ((typeof __GLINT_DESKTOP_BUNDLE__ === "undefined" || !__GLINT_DESKTOP_BUNDLE__) && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4175);
  const host = process.env.GLINT_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && !process.env.GLINT_PUBLIC_HOST) throw new Error("Network binding requires GLINT_PUBLIC_HOST");
  createWebServer().listen(port, host, () => console.log(`[glint-web] serving ${DIST} on ${host}:${port}`));
}
