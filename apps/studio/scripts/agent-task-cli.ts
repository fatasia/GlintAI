import path from "node:path";
import fs from "node:fs";
import { executeTaskPlan, validateTaskPlan } from "./agent-tasks";
import { executeAgentStep } from "./recipe-step";
export async function runAgentTask(planFile: string, directory: string) {
  const planPath = path.resolve(planFile), baseDir = path.dirname(planPath);
  const plan = validateTaskPlan(JSON.parse(fs.readFileSync(planPath, "utf8")));
  if (plan.steps.some(step => step.tool.startsWith("recipe-")))
    throw new Error("Recipe adapters require the digest-approved recipe entry point");
  return executeTaskPlan({ plan, directory, baseDir,
    execute: (step, event) => executeAgentStep(baseDir, step, event) });
}
