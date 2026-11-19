import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { listRecipes } from "@glintai/composer/recipe-sdk";
import { runRecipe } from "./recipe-cli";
import { loadRecipeV2 } from "./recipe-plan-v2";
import { approveRecipe, executeRecipe, recipeStatus } from "./recipe-runtime";
import { executeRecipeV2Step } from "./recipe-execute-v2";
import { createRecipeVerificationAssets, recipeVerificationInput } from "./recipe-verify-fixtures";
import { recipeFileHash } from "./recipe-assets";
async function verifyOne(
  root: string,
  id: string,
  resume: boolean,
  voice: "existing" | "sapi" = "existing",
) {
  const input = recipeVerificationInput(id),
    label = id + (voice === "sapi" ? "-sapi" : ""),
    file = path.join(root, "inputs", label + ".json"),
    directory = path.join(root, label);
  input.voice = voice;
  fs.writeFileSync(file, JSON.stringify(input, null, 2), { flag: "wx" });
  await runRecipe(["plan", "--recipe=" + id, "--input=" + file, "--out=" + directory]);
  const { plan, binding } = loadRecipeV2(directory),
    calls: string[] = [];
  await approveRecipe(directory, binding.planDigest);
  const execute = async (step: Parameters<typeof executeRecipeV2Step>[2]) => {
    calls.push(step.id);
    await executeRecipeV2Step(directory, plan, step);
  };
  if (resume) {
    const controller = new AbortController();
    await assert.rejects(
      executeRecipe(directory, {
        signal: controller.signal,
        execute: async (step) => {
          await execute(step);
          controller.abort();
        },
      }),
    );
  }
  let error: string | undefined;
  try {
    await executeRecipe(directory, { execute });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  if (!error) {
    await executeRecipe(directory, { execute });
    assert.deepEqual(calls, ["materialize", "export", "qa"]);
  }
  const status = recipeStatus(directory),
    qa = path.join(directory, "recipe.qa.json");
  return {
    id: label,
    error,
    calls,
    journal: status.journal,
    qa: fs.existsSync(qa) ? JSON.parse(fs.readFileSync(qa, "utf8")) : null,
    artifacts: plan.steps
      .flatMap((step) => step.outputs)
      .filter((output) => fs.existsSync(path.join(directory, output)))
      .map((output) => ({
        path: path.join(directory, output),
        ...recipeFileHash(path.join(directory, output)),
      })),
  };
}
/** Local evidence runner, not a second task executor. Never calls a network model. */
export async function verifyRecipesV2(root: string) {
  fs.mkdirSync(root);
  await createRecipeVerificationAssets(path.join(root, "inputs"));
  const results = [];
  for (const { id } of listRecipes()) {
    console.log("[recipe-verification] " + id);
    const result = await verifyOne(root, id, id === "source-explainer");
    results.push(result);
    fs.writeFileSync(
      path.join(root, "summary.json"),
      JSON.stringify(
        {
          paidCalls: 0,
          localSapiFixtureCalls: 2,
          note: "Authored illustrations and real local SAPI speech; no generated actors or continuity claim",
          results,
        },
        null,
        2,
      ),
    );
    if (id === "product-promo")
      fs.copyFileSync(path.join(root, id, "prepared.mp4"), path.join(root, "inputs", "source.mp4"));
  }
  results.push(await verifyOne(root, "source-explainer", false, "sapi"));
  fs.writeFileSync(
    path.join(root, "summary.json"),
    JSON.stringify({ paidCalls: 0, localSapiFixtureCalls: 2, results }, null, 2),
  );
  return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("Pass a new evidence output directory");
  const results = await verifyRecipesV2(path.resolve(out));
  if (results.some((result) => result.error)) process.exitCode = 1;
}
