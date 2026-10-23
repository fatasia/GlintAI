import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { executeTaskPlan, validateTaskPlan } from "./agent-tasks";
import fs from "node:fs";

export async function runAgentTask(planFile: string, directory: string) {
  const planPath = path.resolve(planFile), baseDir = path.dirname(planPath), scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const plan = validateTaskPlan(JSON.parse(fs.readFileSync(planPath, "utf8")));
  const require = createRequire(import.meta.url);
  return executeTaskPlan({ plan, directory, baseDir, execute: (step, event) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, path.join(scriptDir, "glint.ts"), step.tool, ...step.args], { cwd: baseDir, env: { ...process.env, INIT_CWD: baseDir }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString(); process.stdout.write(text); event(text); });
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); process.stderr.write(text); event(text); });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`Step ${step.id} exited with code ${code}`)));
  }) });
}
