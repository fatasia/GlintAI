import fs from "node:fs";
import path from "node:path";
import { composeFromMarkdown } from "@glintai/composer";
import { RecipePlan } from "@glintai/composer/recipe-runtime";
import { rebuildRecipe, loadRecipe } from "./recipe-adapter";
import { checkedPath, readLocal, replaceJson, withRecipeLock, writeNew } from "./recipe-files";
import { approveRecipe, executeRecipe, recipeStatus } from "./recipe-runtime";
import { listRecipes, parseRecipeInput } from "@glintai/composer/recipe-sdk";
import { runRecipeV2Plan } from "./recipe-cli-v2";
function parseArgs(args: string[]) {
  const [action, ...rest] = args;
  if (
    !action ||
    !["list", "validate", "plan", "approve", "run", "resume", "status"].includes(action)
  )
    throw new Error("recipe requires list/validate/plan/approve/run/resume/status");
  const values: Record<string, string> = {};
  for (const arg of rest) {
    const match = /^--(source|input|recipe|out|dir|digest|visual|voice)=(.+)$/.exec(arg);
    if (!match || values[match[1]!] !== undefined)
      throw new Error("Invalid or duplicate recipe option");
    values[match[1]!] = match[2]!;
  }
  const allowed =
    action === "plan"
      ? ["source", "input", "recipe", "out", "dir", "visual", "voice"]
      : action === "validate"
        ? ["input"]
        : action === "list"
          ? []
          : action === "approve"
            ? ["dir", "digest"]
            : ["dir"];
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new Error("Option does not apply to this recipe action");
  return { action, values };
}
const resolveInput = (file: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
async function planRecipe(values: Record<string, string>) {
  if (
    (values.visual !== undefined && !["mg", "aigc"].includes(values.visual)) ||
    (values.voice !== undefined && !["existing", "sapi"].includes(values.voice))
  )
    throw new Error("Unsupported visual or voice adapter");
  let directory: string;
  if (values.dir) {
    if (values.source || values.out)
      throw new Error("Replan uses --dir only; edit its source.md/project.json first");
    directory = resolveInput(values.dir);
  } else {
    if (!values.source || !values.out)
      throw new Error("Plan requires --source=<local.md> --out=<new-directory>");
    const source = readLocal(resolveInput(values.source), 64 * 1024);
    const project = composeFromMarkdown(source, {
      projectId: "explainer",
      maxScenes: 6,
      sourceName: "source.md",
    });
    directory = resolveInput(values.out);
    checkedPath(path.dirname(directory));
    fs.mkdirSync(directory);
    writeNew(path.join(directory, "source.md"), source);
    writeNew(path.join(directory, "project.json"), JSON.stringify(project, null, 2));
  }
  return withRecipeLock(directory, async () => {
    if (fs.existsSync(path.join(directory, "task", "journal.json")))
      throw new Error("Executed recipes require a new directory, not a changed plan");
    const previous = values.dir
      ? RecipePlan.parse(JSON.parse(readLocal(path.join(directory, "recipe.plan.json"))))
      : undefined;
    const visual = values.visual ?? previous?.visual ?? "mg",
      voice = values.voice ?? previous?.voice ?? "existing";
    const options = RecipePlan.shape.visual.parse(visual),
      narration = RecipePlan.shape.voice.parse(voice);
    const plan = rebuildRecipe(directory, options, narration);
    replaceJson(path.join(directory, "recipe.plan.json"), plan);
    return {
      directory,
      ...loadRecipe(directory),
      requiresApproval: true,
      narration:
        voice === "existing"
          ? "No narration audio; no automatic voice generation"
          : "Explicit local SAPI voice",
    };
  });
}
/** Shared CLI/Skill entry: no endpoint, provider key, tool name or arbitrary subprocess arguments accepted. */
export async function runRecipe(args: string[]) {
  const { action, values } = parseArgs(args);
  if (action === "list") return listRecipes();
  if (action === "validate") {
    if (!values.input) throw new Error("Validation requires --input=<descriptor.json>");
    return parseRecipeInput(JSON.parse(readLocal(resolveInput(values.input), 8 * 1024 * 1024)));
  }
  if (action === "plan") {
    if (
      values.input ||
      values.recipe ||
      (values.dir && fs.existsSync(path.join(resolveInput(values.dir), "input.json")))
    )
      return runRecipeV2Plan(values);
    return planRecipe(values);
  }
  if (!values.dir) throw new Error("Recipe action requires --dir");
  const directory = resolveInput(values.dir);
  if (action === "approve") {
    if (!values.digest) throw new Error("Approval requires --digest from the reviewed plan");
    return approveRecipe(directory, values.digest);
  }
  if (action === "status") return recipeStatus(directory);
  return executeRecipe(directory);
}
