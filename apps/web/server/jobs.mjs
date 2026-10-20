import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { TEMPLATES, THEME_IDS } from "@glintai/composer/templates";
import { parseProject } from "@glintai/scenescript";
import { configuredVoiceEngines } from "@glintai/tts";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const ID = /^idea-[a-z0-9-]+$/;
export function validateMakeInput(body, templates = TEMPLATES) {
  const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
  const source = typeof body?.source === "string" ? body.source.trim() : "";
  let project;
  if (body?.project !== undefined) {
    try {
      project = parseProject(body.project);
      if (project.scenes.some(scene => !scene.narration.text.trim())) throw new Error("Empty narration");
      if (JSON.stringify(project).length > 100_000 || project.scenes.length > 30 || project.music || project.scenes.some(scene => ["html", "three"].includes(scene.kind) || scene.narration.audioRef || scene.kind === "image" && !/^assets\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(scene.src))) throw new Error("Web projects require text, chart or library image scenes");
    } catch { return { error: "Invalid editor project (maximum 30 scenes, 100000 characters); images must come from the media library" }; }
  }
  if ([Boolean(idea), Boolean(source), Boolean(project)].filter(Boolean).length !== 1) return { error: "Choose exactly one idea, source or project" };
  if (idea.length > 2000 || source.length > 12000) return { error: "Input is too long" };
  const template = body.template;
  if (template !== undefined && !templates.some((entry) => entry.id === template)) return { error: "Unknown template" };
  const theme = body.theme;
  if (theme !== undefined && !THEME_IDS.includes(theme)) return { error: "Invalid theme" };
  const aspect = body.aspect ?? project?.aspect ?? "16:9";
  if (!["16:9", "9:16", "1:1"].includes(aspect)) return { error: "Invalid aspect" };
  const requestId = body.requestId;
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId))) return { error: "Invalid requestId" };
  const tts = body.tts ?? "mock";
  if (!["mock", "sapi", "edge", "qwen", "openai", "elevenlabs", "fish", "minimax", "gateway"].includes(tts)) return { error: "Invalid TTS engine" };
  const music = body.music ?? "off";
  if (typeof music !== "string" || !/^(?:off|auto|[a-zA-Z0-9_-]{1,100}\.(?:mp3|wav))$/.test(music)) return { error: "Invalid music asset" };
  return { idea, source, project, tts, template, theme, aspect, requestId, music };
}

function validVideo(file) {
  let fd;
  try {
    if (fs.statSync(file).size < 24) return false;
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    return header.toString("ascii", 4, 8) === "ftyp";
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Local single-user runner. Only generated ids and whitelisted options become paths/argv. */
export function createJobRunner({ studioDir, templates = TEMPLATES, execPath = process.execPath,
  execArgs, env = process.env, maxConcurrency = 1, spawnFn = spawn, musicAsset = () => null,
  timeoutMs = 15 * 60_000, ttlMs = 7 * 24 * 60 * 60_000,
  killTree = (child) => {
    if (!child.pid) return child.kill();
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  },
} = {}) {
  if (!studioDir || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("Invalid runner configuration");
  const root = path.resolve(studioDir, "out");
  const stateDir = path.join(root, ".jobs");
  fs.mkdirSync(stateDir, { recursive: true });
  const jobs = new Map();
  const queue = [];
  let running = 0;
  let disposed = false;
  const videoPath = (id) => path.join(root, `${id}.mp4`);
  function persist(job) {
    const { control, timer, settled, buffer, ...record } = job;
    const destination = path.join(stateDir, `${job.id}.json`);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, destination);
  }
  // On restart, never retry a paid model request automatically.
  for (const entry of fs.readdirSync(stateDir).filter((name) => /^idea-[a-z0-9-]+\.json$/.test(name)).slice(-1000)) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(stateDir, entry), "utf8"));
      if (!ID.test(job.id) || `${job.id}.json` !== entry || !Number.isFinite(job.createdAt) || !Array.isArray(job.log)) continue;
      if (Date.now() - (job.finishedAt ?? job.createdAt) > ttlMs) { fs.unlinkSync(path.join(stateDir, entry)); continue; }
      if (!TERMINAL.has(job.status) || (job.status === "done" && !validVideo(videoPath(job.id)))) {
        job.status = "failed"; job.stage = "interrupted"; job.error = "Task interrupted. Submit again to retry."; job.finishedAt = Date.now();
      }
      job.log = job.log.filter((line) => ["queued", "compose", "rehearse", "render", "done", "failed", "cancelled", "timed out"].includes(line));
      jobs.set(job.id, job); persist(job);
    } catch { /* Ignore corrupt records; never execute persisted arguments. */ }
  }
  function prune() {
    for (const [id, job] of jobs) if (TERMINAL.has(job.status) && job.settled !== false && Date.now() - (job.finishedAt ?? job.createdAt) > ttlMs) {
      jobs.delete(id);
      try { fs.unlinkSync(path.join(stateDir, `${id}.json`)); } catch { /* Already removed. */ }
    }
  }
  function finish(job, code, failed = false) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    running--;
    if (job.cancelled) job.status = "cancelled";
    else if (!failed && !job.timedOut && code === 0 && validVideo(videoPath(job.id))) job.status = "done";
    else { job.status = "failed"; job.error = job.timedOut ? "Task timed out." : "Generation failed. Check local CLI configuration and source requirements."; }
    job.stage = job.status;
    job.log.push(job.status); job.log = job.log.slice(-20);
    job.finishedAt = Date.now();
    delete job.control;
    persist(job); schedule();
  }
  function start(job) {
    running++; job.status = "running"; job.stage = job.project ? "render" : "compose"; job.settled = false;
    try {
    const args = execArgs ? [...execArgs] : ["--import", pathToFileURL(createRequire(path.join(studioDir, "package.json")).resolve("tsx")).href, path.join(studioDir, "scripts", "glint.ts")];
    if (job.project) {
      const directory = path.join(stateDir, job.id); fs.mkdirSync(directory, { recursive: true });
      for (const scene of job.project.scenes) if (scene.kind === "image") {
        const source = musicAsset(scene.src.slice(7)); if (!source) throw new Error("Image asset missing");
        fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
        fs.copyFileSync(source, path.join(directory, scene.src));
      }
      const file = path.join(directory, "project.json");
      fs.writeFileSync(file, JSON.stringify(job.project));
      args.push("render", `--project=${file}`);
    } else args.push("make", `--id=${job.id}`);
    const music = ["off", "auto"].includes(job.music ?? "off") ? job.music ?? "off" : musicAsset(job.music);
    if (!music) throw new Error("Music asset no longer available");
    args.push(`--aspect=${job.aspect}`, `--music=${music}`, `--out=${videoPath(job.id)}`, `--tts=${job.tts}`);
    if (job.encoding === "draft") args.push("--fast");
    else args.push(`--encoding=${job.encoding}`);
    if (job.tts === "qwen") args.push(`--tts-python=${env.GLINT_QWEN_PYTHON || "python"}`, `--tts-model=${env.GLINT_QWEN_MODEL}`, `--reference-audio=${env.GLINT_QWEN_REFERENCE}`, "--tts-concurrency=1", ...(env.GLINT_QWEN_REFERENCE_TEXT ? [`--reference-text=${env.GLINT_QWEN_REFERENCE_TEXT}`] : []));
    if (job.source) {
      const sourcePath = path.join(stateDir, `${job.id}.md`);
      fs.writeFileSync(sourcePath, job.source);
      args.push(`--source=${sourcePath}`, "--engine=heuristic");
    } else if (!job.project) args.push(`--idea=${job.idea}`, "--engine=llm");
    if (!job.project && job.template) args.push(`--template=${job.template}`);
    if (!job.project && job.theme) args.push(`--theme=${job.theme}`);
    persist(job);
      const child = spawnFn(execPath, args, { cwd: studioDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
      job.control = child;
      // Never expose child output: it may contain provider bodies, credentials or source text.
      const onOutput = (chunk) => {
        job.buffer = ((job.buffer ?? "") + chunk.toString()).slice(-8192);
        const lines = job.buffer.split(/\r?\n/); job.buffer = lines.pop();
        for (const line of lines) {
          const stage = /^\[glint\] 1\/4 composing/.test(line) ? "compose" : /^\[glint\] 2\/4 rehearsal/.test(line) ? "rehearse" : /^\[glint\] 4\/4 rendering/.test(line) ? "render" : null;
          if (stage && stage !== job.stage) { job.stage = stage; job.log.push(stage); job.log = job.log.slice(-20); persist(job); }
        }
      };
      child.stdout?.on("data", onOutput); child.stderr?.on("data", onOutput);
      child.once("error", () => finish(job, -1, true));
      child.once("close", (code) => finish(job, code));
      job.timer = setTimeout(() => {
        job.timedOut = true; job.stage = "stopping"; job.log.push("timed out"); persist(job);
        try { killTree(child); } catch { finish(job, -1, true); }
      }, timeoutMs);
      job.timer.unref?.();
    } catch { finish(job, -1, true); }
  }
  function schedule() {
    while (!disposed && running < maxConcurrency && queue.length) {
      const job = queue.shift();
      if (job.status === "queued") start(job);
    }
  }
  return {
    submit(input) {
      if (disposed) return { error: "Runner stopped" };
      prune();
      const validated = validateMakeInput(input, templates);
      if (validated.error) return validated;
      if (validated.project?.scenes.some(scene => scene.kind === "image" && !musicAsset(scene.src.slice(7)))) return { error: "Image asset not found in this server's library" };
      if (!["off", "auto"].includes(validated.music) && !musicAsset(validated.music)) return { error: "Music asset not found; generate or import it first" };
      if (validated.tts === "sapi" && process.platform !== "win32") return { error: "System voice is available on Windows only" };
      if (validated.tts === "qwen" && (!env.GLINT_QWEN_MODEL || !env.GLINT_QWEN_REFERENCE)) return { error: "Configure local Qwen model and authorized reference on the server" };
      if (!configuredVoiceEngines(env).includes(validated.tts)) return { error: "Configure the selected TTS engine on the server" };
      const encoding = input.encoding ?? "draft";
      if (!["draft", "compact", "balanced", "quality"].includes(encoding)) return { error: "Invalid encoding profile" };
      validated.encoding = encoding;
      if (validated.requestId) {
        const previous = [...jobs.values()].find((job) => job.requestId === validated.requestId);
        if (previous) {
          if (["idea", "source", "project", "tts", "encoding", "template", "theme", "aspect", "music"].some((field) => JSON.stringify(previous[field] ?? (field === "music" ? "off" : undefined)) !== JSON.stringify(validated[field]))) return { error: "requestId already belongs to different input" };
          return { jobId: previous.id };
        }
      }
      if (running + queue.length >= maxConcurrency + 4) return { error: "Too many jobs; try again later." };
      const job = { ...validated, id: `idea-${randomUUID()}`, status: "queued", stage: "queued", log: ["queued"], createdAt: Date.now() };
      jobs.set(job.id, job); persist(job); queue.push(job); schedule();
      return { jobId: job.id };
    },
    get(id) {
      prune(); const job = jobs.get(id);
      if (!job) return null;
      return { id, status: job.status, stage: job.stage, log: [...job.log], video: job.status === "done" ? `/api/video/${id}` : undefined, error: job.status === "failed" ? job.error : undefined };
    },
    findRequest(requestId) {
      prune();
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) return null;
      const job = [...jobs.values()].find(job => job.requestId === requestId);
      return job ? this.get(job.id) : null;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return false;
      if (job.cancelled || job.status === "cancelled") return true;
      if (TERMINAL.has(job.status)) return false;
      job.cancelled = true;
      if (job.status === "queued") {
        queue.splice(queue.indexOf(job), 1); job.status = "cancelled"; job.stage = "cancelled"; job.finishedAt = Date.now(); persist(job);
      } else {
        job.status = "cancelling"; job.stage = "stopping"; persist(job);
        try { killTree(job.control); } catch { /* Deadline will retry termination. */ }
      }
      return true;
    },
    videoFile(id) { return jobs.get(id)?.status === "done" && validVideo(videoPath(id)) ? videoPath(id) : null; },
    dispose() {
      disposed = true;
      for (const job of jobs.values()) if (job.control && !job.settled) {
        clearTimeout(job.timer); try { killTree(job.control); } catch { /* Process already stopped. */ }
      }
    },
    _tests: { get size() { return jobs.size; }, get pending() { return running + queue.length; } },
  };
}
