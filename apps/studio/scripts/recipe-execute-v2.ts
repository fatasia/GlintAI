import fs from "node:fs";
import path from "node:path";
import type { RecipePlanV2 } from "@glintai/composer/recipe-v2";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import { validateReceipt } from "@glintai/buildgraph";
import { buildProject } from "./build";
import { renderNle } from "./nle-render";
import { runQa } from "./qa";
import { writeNew, readLocal } from "./recipe-files";
import {
  recipeDrafts,
  recipeVideos,
  recipeExportArtifacts,
  materializeOutputs,
} from "./recipe-plan-v2";
import { recipeFileHash, probeRecipeAsset } from "./recipe-assets";
import { materializeApprovedRecipe } from "./recipe-materialize";
import type { TaskStep } from "./agent-tasks";
import { verifyRecipeReceipt } from "./recipe-receipts";

async function exportRecipe(directory: string, plan: RecipePlanV2) {
  verifyRecipeReceipt(
    directory,
    "materialize.receipt.json",
    materializeOutputs(plan.input, plan.assets).filter(
      (file) => file !== "materialize.receipt.json",
    ),
    plan.inputDigest,
    "files",
  );
  const drafts = recipeDrafts(plan.input, plan.assets),
    videos = recipeVideos(plan.input, plan.assets);
  for (const [index, item] of drafts.entries()) {
    const projectFile = path.join(directory, item.file),
      out = path.join(directory, videos[index]!);
    if (item.kind === "scene") {
      parseProject(JSON.parse(readLocal(projectFile)));
      await buildProject({
        projectPath: projectFile,
        output: out,
        tts: "existing",
        music: "off",
        resolution: "540",
      });
      parseProject(JSON.parse(readLocal(out + ".project.json")));
      validateReceipt(JSON.parse(readLocal(out + ".receipt.json")));
    } else {
      parseNleProject(JSON.parse(readLocal(projectFile)));
      await renderNle({
        projectFile,
        assetsDir: path.join(directory, "assets"),
        out,
        encoding: "draft",
      });
    }
    probeRecipeAsset(out, "video");
  }
  const receipt = {
    version: 1,
    adapter: "builtin-recipe-export-v2",
    inputDigest: plan.inputDigest,
    modelCalls: 0,
    outputs: recipeExportArtifacts(plan.input, plan.assets).map((file) => ({
      file,
      ...recipeFileHash(path.join(directory, file)),
    })),
  };
  writeNew(path.join(directory, "export.receipt.json"), JSON.stringify(receipt, null, 2));
}
async function checkRecipe(directory: string, plan: RecipePlanV2) {
  verifyRecipeReceipt(
    directory,
    "export.receipt.json",
    recipeExportArtifacts(plan.input, plan.assets),
    plan.inputDigest,
    "outputs",
  );
  const reports = [];
  for (const file of recipeVideos(plan.input, plan.assets))
    reports.push({ file, report: await runQa(path.join(directory, file)) });
  writeNew(
    path.join(directory, "recipe.qa.json"),
    JSON.stringify({ version: 1, inputDigest: plan.inputDigest, reports }, null, 2),
  );
  if (reports.some((item) => item.report.verdict === "red"))
    throw new Error("Recipe export failed delivery QA; inspect recipe.qa.json");
}
/** Fixed built-in dispatch, reachable only after recipe digest approval. */
export async function executeRecipeV2Step(directory: string, plan: RecipePlanV2, step: TaskStep) {
  if (step.args.length) throw new Error("Recipe adapters do not accept tool arguments");
  if (step.tool === "recipe-materialize") await materializeApprovedRecipe(directory, plan);
  else if (step.tool === "recipe-export") await exportRecipe(directory, plan);
  else if (step.tool === "recipe-qa") await checkRecipe(directory, plan);
  else throw new Error("Unknown recipe adapter");
  for (const output of step.outputs) {
    if (!fs.existsSync(path.join(directory, output)))
      throw new Error("Recipe adapter output missing: " + output);
    recipeFileHash(path.join(directory, output));
  }
}
