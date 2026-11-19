// SKILL-10: skill run contract, isolation and receipts (ADR-012).
// A skill is runnable only with a glint.skill.json manifest; runs execute the
// manifest entry as a fixed `node <entry>` subprocess in a throwaway workspace,
// with default-deny capability grants and an append-only receipt ledger.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const SAFE_SKILL = /^[a-zA-Z0-9_-]{1,64}$/;
const RECEIPT_FILE = "skills-runs.jsonl";
const CREDENTIAL_PREFIX = "GLINT_";
const BASE_ENV = ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "WINDIR", "NODE_OPTIONS"];

export function createSkillRuntime({ repoRoot, dataDir, env = process.env, spawnImpl = spawn, now = () => new Date().toISOString(), id = () => randomUUID(), parseProject }) {
  const runsDir = path.join(dataDir, "skill-runs");
  const receiptFile = path.join(dataDir, RECEIPT_FILE);
  const lockFile = path.join(repoRoot, "skills-lock.json");
  const skillRoot = name => path.join(repoRoot, "skills", name);

  function readManifest(skill) {
    if (!SAFE_SKILL.test(skill)) return { error: "Invalid skill id" };
    const file = path.join(skillRoot(skill), "glint.skill.json");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { error: `Skill "${skill}" has no run contract (glint.skill.json); installed Markdown skills are browse-only` }; }
    if (typeof manifest.entry !== "string" || !manifest.entry) return { error: "Manifest entry must be a relative path" };
    const entry = path.join(skillRoot(skill), manifest.entry);
    if (!entry.startsWith(path.join(skillRoot(skill)) + path.sep) || !/\.mjs$/.test(entry)) return { error: "Manifest entry must stay inside the skill directory and be a .mjs file" };
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) return { error: `Manifest entry "${manifest.entry}" does not exist` };
    const outputs = Array.isArray(manifest.outputs) ? manifest.outputs.filter(item => item === "projectPatch" || item === "assets") : [];
    const timeoutMs = Number.isFinite(manifest.timeoutMs) ? Math.min(Math.max(manifest.timeoutMs, 1000), 600_000) : 120_000;
    return { manifest: { entry, outputs, timeoutMs } };
  }

  function lockHash(skill) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")).skills ?? {};
      return lock[skill]?.computedHash ?? null;
    } catch { return null; }
  }

  function appendReceipt(receipt) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(receiptFile, JSON.stringify(receipt) + "\n");
  }

  function collectOutputs(workspace, grants) {
    const out = path.join(workspace, "out");
    if (!grants.assets || !fs.existsSync(out)) return [];
    const kept = path.join(dataDir, "skill-assets");
    fs.mkdirSync(kept, { recursive: true });
    const names = [];
    for (const name of fs.readdirSync(out)) {
      if (!/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav|json)$/.test(name)) continue;
      const file = path.join(out, name);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 300 * 1024 * 1024) continue;
      const target = path.join(kept, `${randomUUID().slice(0, 8)}-${name}`);
      fs.copyFileSync(file, target);
      names.push(path.basename(target));
    }
    return names;
  }

  return {
    /** Contract + lock check without executing; used by the catalog and tests. */
    inspect(skill) {
      const manifest = readManifest(skill);
      if (manifest.error) return { runnable: false, error: manifest.error };
      const hash = lockHash(skill);
      return { runnable: true, manifest, hash, pinned: hash !== null };
    },
    receipts(limit = 50) {
      try {
        const lines = fs.readFileSync(receiptFile, "utf8").split("\n").filter(Boolean);
        return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return { unparsable: true }; } });
      } catch { return []; }
    },
    /** Execute one declared skill run. Never throws: failures become receipts. */
    run(request, callback = () => {}) {
      const startedAt = now(), runId = id();
      const skill = request?.skill;
      const manifest = readManifest(skill);
      if (manifest.error) {
        const receipt = { runId, skill, ok: false, refused: manifest.error, startedAt, durationMs: 0 };
        appendReceipt(receipt);
        return Promise.resolve(receipt);
      }
      const hash = lockHash(skill);
      if (!hash) {
        const receipt = { runId, skill, ok: false, refused: "Skill is not pinned in skills-lock.json (hash unknown)", startedAt, durationMs: 0 };
        appendReceipt(receipt);
        return Promise.resolve(receipt);
      }
      const grants = {
        project: request.grants?.project === true,
        assets: request.grants?.assets === true,
        network: request.grants?.network === true,
      };
      fs.mkdirSync(runsDir, { recursive: true });
      const workspace = fs.mkdtempSync(path.join(runsDir, `${skill}-`));
      const childEnv = {};
      for (const key of BASE_ENV) if (env[key] !== undefined) childEnv[key] = env[key];
      if (grants.network) for (const [key, value] of Object.entries(env)) if (key.startsWith(CREDENTIAL_PREFIX)) childEnv[key] = value;
      const payload = JSON.stringify({ skill, hash, inputs: request.inputs ?? {}, grants, workspace });
      const started = Date.now();
      return new Promise(resolve => {
        const child = spawnImpl(process.execPath, [manifest.manifest.entry], { cwd: workspace, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "", settled = false;
        const timer = setTimeout(() => { if (!settled) { child.kill("SIGKILL"); } }, manifest.manifest.timeoutMs);
        const finish = ok => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          let result = null, parseError;
          try { result = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null"); } catch (error) { parseError = String(error).slice(0, 120); }
          let projectPatch;
          if (grants.project && result && result.projectPatch !== undefined) {
            try { if (parseProject) { parseProject(result.projectPatch); projectPatch = result.projectPatch; } else projectPatch = result.projectPatch; } catch (error) { callback({ type: "patch-refused", reason: String(error).slice(0, 160) }); }
          }
          const assets = manifest.manifest.outputs.includes("assets") ? collectOutputs(workspace, grants) : [];
          const receipt = {
            runId, skill, hash, grants, ok: ok === true && result !== null,
            exit: { code: child.exitCode, signal: child.signalCode ?? undefined },
            ...(projectPatch ? { projectPatch } : {}),
            ...(assets.length ? { assets } : {}),
            notes: typeof result?.notes === "string" ? result.notes.slice(0, 2000) : undefined,
            ...(parseError ? { resultParseError: parseError } : {}),
            logs: stderr ? stderr.slice(-8000) : undefined,
            startedAt, durationMs: Date.now() - started,
          };
          appendReceipt(receipt);
          fs.rmSync(workspace, { recursive: true, force: true });
          resolve(receipt);
        };
        child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-1_000_000); });
        child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32_000); });
        child.once("error", error => { stderr += `\nspawn error: ${error.message}`; finish(false); });
        child.once("close", () => finish(true));
        child.stdin.write(payload + "\n");
        child.stdin.end();
      });
    },
  };
}

/** Entry helper for run.mjs scripts: read the request line, hand the skill a
 * workspace, and print exactly one JSON result line. */
export async function skillMain(handler) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await handler(request);
  process.stdout.write(JSON.stringify(result ?? {}) + "\n");
}
