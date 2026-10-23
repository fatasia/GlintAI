import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface TaskStep { id: string; tool: string; args: string[]; dependsOn: string[]; outputs: string[] }
export interface TaskPlan { version: 1; title: string; steps: TaskStep[] }
export interface StepRecord { state: "pending" | "running" | "completed" | "failed"; attempts: number; error?: string; artifacts?: { path: string; sha256: string }[] }
export interface TaskJournal { version: 1; planDigest: string; steps: Record<string, StepRecord>; updatedAt: string }
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const allowedTools = new Set(["review", "insights", "render-native", "render", "lint", "qa", "deck", "srt", "check", "rehearse", "reexplain", "ask", "media"]);

export function validateTaskPlan(value: unknown): TaskPlan {
  const plan = value as TaskPlan;
  if (plan?.version !== 1 || typeof plan.title !== "string" || !plan.title.trim() || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 100) throw new Error("Invalid task plan header");
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(step.id) || ids.has(step.id) || !allowedTools.has(step.tool)) throw new Error("Invalid, duplicate step ID or unapproved tool");
    if (!Array.isArray(step.args) || step.args.some(arg => typeof arg !== "string" || arg.length > 12000 || /api.?key|authorization|bearer|token=/i.test(arg))) throw new Error("Task arguments must be bounded strings without credentials");
    if (!Array.isArray(step.dependsOn) || !Array.isArray(step.outputs) || step.outputs.some(file => typeof file !== "string" || !file.trim())) throw new Error("Task dependencies and outputs must be arrays");
    if (step.dependsOn.some(id => !ids.has(id))) throw new Error("Dependencies must reference preceding steps (cycles and forward references are forbidden)");
    // Every paid submission must be recoverable by an already-issued task ID.
    if (step.tool === "media" && !step.args.some(arg => /^--task=[a-zA-Z0-9_-]+$/.test(arg)) && !step.args.some(arg => arg.startsWith("--list="))) throw new Error("Task runner only resumes media with --task; submit paid media explicitly once");
    ids.add(step.id);
  }
  return plan;
}

function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
  fs.renameSync(temp, file);
}

export async function executeTaskPlan(options: {
  plan: TaskPlan; directory: string; baseDir: string;
  execute: (step: TaskStep, event: (message: string) => void) => Promise<void>;
  signal?: AbortSignal;
}) {
  const plan = validateTaskPlan(options.plan), directory = path.resolve(options.directory);
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, "run.lock"), journalPath = path.join(directory, "journal.json");
  const lock = fs.openSync(lockPath, "wx");
  let journal: TaskJournal;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const planDigest = digest(JSON.stringify({ plan, baseDir: path.resolve(options.baseDir) }));
    journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : { version: 1, planDigest, steps: {}, updatedAt: "" };
    if (journal.version !== 1 || journal.planDigest !== planDigest) throw new Error("Plan changed; use a new task directory to preserve prior history");
    const event = (value: object) => fs.appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
    const save = () => { journal.updatedAt = new Date().toISOString(); atomicJson(journalPath, journal); };
    atomicJson(path.join(directory, "plan.json"), plan);
    for (const step of plan.steps) {
      options.signal?.throwIfAborted();
      const record = journal.steps[step.id] ??= { state: "pending", attempts: 0 };
      const outputs = step.outputs.map(file => path.resolve(options.baseDir, file));
      if (record.state === "completed") {
        const intact = outputs.length > 0 && record.artifacts?.length === outputs.length && record.artifacts.every((artifact, i) => artifact.path === outputs[i] && fs.existsSync(artifact.path) && digest(fs.readFileSync(artifact.path)) === artifact.sha256);
        if (intact) { event({ stepId: step.id, type: "cache-hit" }); continue; }
        throw new Error(`Completed artifact missing or changed for ${step.id}; refusing automatic overwrite or paid resubmission`);
      }
      if (record.state === "running") event({ stepId: step.id, type: "recovered-interruption" });
      for (const dep of step.dependsOn) if (journal.steps[dep]?.state !== "completed") throw new Error(`Dependency ${dep} is incomplete`);
      record.state = "running"; record.attempts++; delete record.error; save();
      event({ stepId: step.id, type: "tool-start", tool: step.tool, args: step.args });
      try {
        await options.execute(step, message => event({ stepId: step.id, type: "tool-output", message: message.slice(0, 4000) }));
        record.artifacts = outputs.map(file => {
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Expected output missing: ${file}`);
          return { path: file, sha256: digest(fs.readFileSync(file)) };
        });
        record.state = "completed"; save(); event({ stepId: step.id, type: "tool-completed", artifacts: record.artifacts });
      } catch (error) {
        record.state = "failed"; record.error = error instanceof Error ? error.message : String(error); save();
        event({ stepId: step.id, type: "tool-failed", error: record.error }); throw error;
      }
    }
    return journal;
  } finally { fs.closeSync(lock); fs.rmSync(lockPath, { force: true }); }
}
