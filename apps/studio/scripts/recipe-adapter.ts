import path from "node:path";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { RecipePlan, requireExecutableRecipe } from "@glintai/composer/recipe-runtime";
import { THEME_IDS } from "@glintai/composer/templates";
import { buildProjectPlan } from "./project-plan";
import { digest, readLocal } from "./recipe-files";
import { loadRecipeV2 } from "./recipe-plan-v2";
const nativeKinds = new Set([
  "title",
  "bullets",
  "definition",
  "comparison",
  "quote",
  "chart",
  "diagram",
]);
function assertLocalProject(raw: unknown): SceneScriptProject {
  const project = parseProject(raw);
  if (
    project.id !== "explainer" ||
    project.music ||
    project.sfx?.length ||
    project.assets?.length ||
    project.scenes.length > 20 ||
    typeof project.theme !== "string" ||
    !(THEME_IDS as readonly string[]).includes(project.theme)
  )
    throw new Error("Recipe requires its local explainer project without music");
  if (
    project.scenes.some(
      (scene) =>
        !nativeKinds.has(scene.kind) ||
        scene.narration.audioRef ||
        scene.elements?.length ||
        scene.sharedElements?.length ||
        scene.assetRefs?.length,
    )
  )
    throw new Error("Recipe supports native scenes without external audio/assets only");
  const text = JSON.stringify(raw);
  if (/https?:|file:|data:|javascript:|\\\\/i.test(text))
    throw new Error("Recipe input contains external resources");
  return project;
}
export function rebuildRecipe(
  directory: string,
  visual: "mg" | "aigc",
  voice: "existing" | "sapi",
): RecipePlan {
  const input = readLocal(path.join(directory, "source.md"), 64 * 1024);
  const projectText = readLocal(path.join(directory, "project.json"));
  assertLocalProject(JSON.parse(projectText));
  const task = buildProjectPlan(path.join(directory, "project.json"), {
    tts: voice,
    resolution: "540",
  });
  const render = task.steps.find((step) => step.id === "render")!;
  render.tool = "build";
  render.outputs.push("explainer.mp4.receipt.json");
  const quote = {
    amount: visual === "mg" ? ("0" as const) : null,
    unit: "CNY" as const,
    source: visual === "mg" ? ("builtin-local-adapter" as const) : ("unknown" as const),
    scope: "model-service-fee-only" as const,
  };
  return RecipePlan.parse({
    format: "glint-recipe-plan",
    version: 1,
    recipeId: "source-explainer",
    recipeVersion: "1.0.0",
    visual,
    voice,
    inputDigest: digest(input),
    projectDigest: digest(projectText),
    stepsDigest: digest(JSON.stringify(task.steps)),
    quoteDigest: digest(JSON.stringify(quote)),
    quote,
    steps: task.steps,
  });
}
export function loadAnyRecipe(directory: string, executable = false) {
  const raw = JSON.parse(readLocal(path.join(directory, "recipe.plan.json"), 10 * 1024 * 1024));
  if (raw?.version === 2) return loadRecipeV2(directory, executable);
  return loadRecipe(directory, executable);
}
export function loadRecipe(directory: string, executable = false) {
  const stored = RecipePlan.parse(JSON.parse(readLocal(path.join(directory, "recipe.plan.json"))));
  const rebuilt = rebuildRecipe(directory, stored.visual, stored.voice);
  if (JSON.stringify(stored) !== JSON.stringify(rebuilt))
    throw new Error("Recipe inputs or steps changed; replan and approve again");
  if (executable) requireExecutableRecipe(rebuilt);
  const planDigest = digest(JSON.stringify(rebuilt));
  return {
    plan: rebuilt,
    binding: {
      planDigest,
      inputDigest: rebuilt.inputDigest,
      projectDigest: rebuilt.projectDigest,
      stepsDigest: rebuilt.stepsDigest,
      quoteDigest: rebuilt.quoteDigest,
    },
  };
}
