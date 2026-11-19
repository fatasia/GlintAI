import fs from "node:fs";
import path from "node:path";
import { createRecipeV2, rebuildRecipeV2, loadRecipeV2 } from "./recipe-plan-v2";
import { replaceJson, withRecipeLock } from "./recipe-files";
const resolve = (file: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
export async function runRecipeV2Plan(values: Record<string, string>) {
  if (values.source || values.visual || values.voice)
    throw new Error("Version 2 choices belong in the reviewed input descriptor");
  let directory: string;
  if (values.dir) {
    if (values.input || values.out || values.recipe) throw new Error("Replan uses --dir only");
    directory = resolve(values.dir);
  } else {
    if (!values.input || !values.out || !values.recipe)
      throw new Error(
        "Plan requires --recipe=<id> --input=<descriptor.json> --out=<new-directory>",
      );
    directory = resolve(values.out);
    createRecipeV2(resolve(values.input), directory, values.recipe);
  }
  return withRecipeLock(directory, async () => {
    if (fs.existsSync(path.join(directory, "task", "journal.json")))
      throw new Error("Executed recipes require a new directory, not a changed plan");
    replaceJson(path.join(directory, "recipe.plan.json"), rebuildRecipeV2(directory));
    return { directory, ...loadRecipeV2(directory), requiresApproval: true };
  });
}
