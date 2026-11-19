import fs from "node:fs";
import path from "node:path";
import { requireTaskApproval } from "@glintai/composer/recipe-runtime";
import { executeTaskPlan, type TaskStep } from "./agent-tasks";
import { loadAnyRecipe as loadRecipe } from "./recipe-adapter";
import { checkedPath, readLocal, withRecipeLock, writeNew } from "./recipe-files";
import { executeAgentStep } from "./recipe-step";
import { executeRecipeV2Step } from "./recipe-execute-v2";
const approvalFile = (directory: string, digest: string) =>
  path.join(directory, "approval-" + digest + ".json");
export async function approveRecipe(directory: string, expectedDigest: string) {
  return withRecipeLock(directory, async () => {
    const { binding } = loadRecipe(directory, true);
    if (binding.planDigest !== expectedDigest)
      throw new Error("Review the current plan digest before approving");
    const file = approvalFile(directory, expectedDigest);
    if (fs.existsSync(file)) return requireTaskApproval(JSON.parse(readLocal(file)), binding);
    const approval = {
      format: "glint-task-approval",
      version: 1,
      ...binding,
      confirmedAt: new Date().toISOString(),
    };
    writeNew(file, JSON.stringify(approval, null, 2));
    return requireTaskApproval(approval, binding);
  });
}
export function recipeStatus(directory: string) {
  const { plan, binding } = loadRecipe(directory);
  const file = approvalFile(directory, binding.planDigest),
    journal = path.join(directory, "task", "journal.json");
  const approved =
    fs.existsSync(file) && Boolean(requireTaskApproval(JSON.parse(readLocal(file)), binding));
  return {
    plan,
    ...binding,
    approved,
    journal: fs.existsSync(journal) ? JSON.parse(readLocal(journal)) : null,
    narration:
      (plan.version === 1 ? plan.voice : plan.input.voice) === "existing"
        ? plan.version === 1
          ? "No narration audio; no automatic voice generation"
          : "Uses supplied audio; no automatic voice generation"
        : "Explicit local SAPI voice",
  };
}
export async function executeRecipe(
  directory: string,
  options: {
    signal?: AbortSignal;
    execute?: (step: TaskStep, event: (message: string) => void) => Promise<void>;
  } = {},
) {
  return withRecipeLock(directory, async () => {
    const initial = loadRecipe(directory, true);
    const taskDir = path.join(directory, "task");
    if (fs.existsSync(taskDir)) {
      checkedPath(taskDir);
      for (const file of fs.readdirSync(taskDir)) checkedPath(path.join(taskDir, file));
    }
    const check = () => {
      const current = loadRecipe(directory, true);
      if (current.binding.planDigest !== initial.binding.planDigest)
        throw new Error("Recipe changed during execution");
      requireTaskApproval(
        JSON.parse(readLocal(approvalFile(directory, current.binding.planDigest))),
        current.binding,
      );
    };
    check();
    return executeTaskPlan({
      directory: taskDir,
      baseDir: directory,
      signal: options.signal,
      plan: {
        version: 1,
        title: initial.plan.version === 1 ? "Approved source explainer" : "Approved recipe",
        steps: initial.plan.steps,
      },
      beforeStep: (step, record) => {
        check();
        if (record.state === "running" || record.state === "failed")
          throw new Error("Prior step is uncertain; inspect original task, no automatic replay");
        for (const output of step.outputs) {
          const file = path.join(directory, output);
          if (fs.existsSync(file)) {
            checkedPath(file);
            if (record.state !== "completed")
              throw new Error("Unowned recipe output already exists");
          }
        }
      },
      execute:
        options.execute ??
        ((step, event) =>
          initial.plan.version === 2
            ? executeRecipeV2Step(directory, initial.plan, step)
            : executeAgentStep(directory, step, event)),
    });
  });
}
