import fs from "node:fs";
import path from "node:path";
import { parseRecipeInput, type RecipeInput } from "@glintai/composer/recipe-inputs";
import { BoundRecipeAsset, RecipePlanV2 } from "@glintai/composer/recipe-v2";
import { digest, readLocal, writeNew, checkedPath } from "./recipe-files";
import { importRecipeAssets, verifyRecipeAssets } from "./recipe-assets";
import { recipeSceneProject, recipeDramaProject, recipeClipProjects } from "./recipe-projects";

export function recipeDrafts(input: RecipeInput, assets: BoundRecipeAsset[]) {
  if (input.recipeId === "drama-two-shot")
    return [
      {
        file: "prepared.nle.json",
        kind: "nle" as const,
        project: recipeDramaProject(input, assets),
      },
    ];
  if (input.recipeId === "longform-clips")
    return recipeClipProjects(input, assets).map((item) => ({
      file: item.id + ".nle.json",
      kind: "nle" as const,
      project: item.nle,
    }));
  return [
    {
      file: "prepared.project.json",
      kind: "scene" as const,
      project: recipeSceneProject(input, assets),
    },
  ];
}
export function materializeOutputs(input: RecipeInput, assets: BoundRecipeAsset[]) {
  const outputs = recipeDrafts(input, assets).map((item) => item.file);
  if (input.recipeId === "slides-video")
    outputs.push(...input.content.document.pages.map((_, i) => "assets/recipe-page-" + i + ".png"));
  if (input.voice === "sapi")
    outputs.push(
      ...recipeSceneProject(input, assets).scenes.map(
        (_, i) => "assets/recipe-voice-" + i + ".wav",
      ),
    );
  return [...outputs, "materialize.receipt.json"];
}
export function recipeVideos(input: RecipeInput, assets: BoundRecipeAsset[]) {
  return recipeDrafts(input, assets).map((item) =>
    item.file.replace(/\.(nle|project)\.json$/, ".mp4"),
  );
}
export function recipeExportArtifacts(input: RecipeInput, assets: BoundRecipeAsset[]) {
  return recipeDrafts(input, assets).flatMap((item) => {
    const video = item.file.replace(/\.(nle|project)\.json$/, ".mp4");
    return item.kind === "nle"
      ? [video, video.replace(/\.mp4$/, ".cover.jpg")]
      : [
          video,
          video + ".project.json",
          video + ".receipt.json",
          video + ".metrics.json",
          video + ".srt",
        ];
  });
}
export function rebuildRecipeV2(directory: string): RecipePlanV2 {
  const input = parseRecipeInput(
    JSON.parse(readLocal(path.join(directory, "input.json"), 8 * 1024 * 1024)),
  );
  const assets = BoundRecipeAsset.array()
    .max(40)
    .parse(JSON.parse(readLocal(path.join(directory, "assets.json"))));
  if (
    assets.length !== input.assets.length ||
    assets.some(
      (a, i) =>
        a.id !== input.assets[i]?.id ||
        a.file !== input.assets[i]?.file ||
        a.kind !== input.assets[i]?.kind,
    )
  )
    throw new Error("Bound assets do not match input descriptor");
  verifyRecipeAssets(directory, assets);
  if (assets.some((asset) => asset.id.startsWith("recipe-")))
    throw new Error("Asset IDs prefixed recipe- are reserved for owned outputs");
  if (
    ["drama-two-shot", "longform-clips"].includes(input.recipeId) &&
    (input.voice !== "existing" || input.audio.length)
  )
    throw new Error("This adapter preserves source audio; separate narration is unsupported");
  const drafts = recipeDrafts(input, assets),
    videos = recipeExportArtifacts(input, assets);
  const steps = recipeSteps(input, assets, videos);
  const quote = {
    amount: input.visual === "aigc" ? null : "0",
    unit: "CNY",
    source: input.visual === "aigc" ? "unknown" : "builtin-local-adapter",
    scope: "model-service-fee-only",
  };
  return RecipePlanV2.parse({
    format: "glint-recipe-plan",
    version: 2,
    recipeVersion: "2.0.0",
    input,
    assets,
    inputDigest: digest(JSON.stringify({ input, assets })),
    projectDigest: digest(JSON.stringify(drafts)),
    stepsDigest: digest(JSON.stringify(steps)),
    quoteDigest: digest(JSON.stringify(quote)),
    quote,
    steps,
  });
}
function recipeSteps(input: RecipeInput, assets: BoundRecipeAsset[], videos: string[]) {
  return [
    {
      id: "materialize",
      tool: "recipe-materialize",
      args: [],
      dependsOn: [],
      outputs: materializeOutputs(input, assets),
    },
    {
      id: "export",
      tool: "recipe-export",
      args: [],
      dependsOn: ["materialize"],
      outputs: [...videos, "export.receipt.json"],
    },
    { id: "qa", tool: "recipe-qa", args: [], dependsOn: ["export"], outputs: ["recipe.qa.json"] },
  ];
}
export function loadRecipeV2(directory: string, executable = false) {
  const stored = RecipePlanV2.parse(
    JSON.parse(readLocal(path.join(directory, "recipe.plan.json"), 10 * 1024 * 1024)),
  );
  const plan = rebuildRecipeV2(directory);
  if (JSON.stringify(stored) !== JSON.stringify(plan))
    throw new Error("Recipe inputs or steps changed; replan and approve again");
  if (executable && plan.quote.amount === null)
    throw new Error("New AIGC generation has unknown paid effects and is blocked");
  return {
    plan,
    binding: {
      planDigest: digest(JSON.stringify(plan)),
      inputDigest: plan.inputDigest,
      projectDigest: plan.projectDigest,
      stepsDigest: plan.stepsDigest,
      quoteDigest: plan.quoteDigest,
    },
  };
}
export function createRecipeV2(file: string, directory: string, expectedId?: string) {
  const input = parseRecipeInput(JSON.parse(readLocal(file, 8 * 1024 * 1024)));
  if (expectedId && expectedId !== input.recipeId)
    throw new Error("Recipe ID does not match descriptor");
  checkedPath(path.dirname(directory));
  fs.mkdirSync(directory);
  const assets = importRecipeAssets(input, path.dirname(file), directory);
  const remap = new Map(input.assets.map((a, i) => [a.file, assets[i]!.file]));
  if (input.recipeId === "localized-voice")
    for (const scene of input.content.project.scenes)
      if (scene.kind === "image" || scene.kind === "video")
        scene.src = remap.get(scene.src) ?? scene.src;
  input.assets = assets.map(({ id, file: ownedFile, kind }) => ({ id, file: ownedFile, kind }));
  writeNew(path.join(directory, "input.json"), JSON.stringify(input, null, 2));
  writeNew(path.join(directory, "assets.json"), JSON.stringify(assets, null, 2));
  return rebuildRecipeV2(directory);
}
