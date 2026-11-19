import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SapiTtsProvider } from "@glintai/tts";
import type { RecipePlanV2, BoundRecipeAsset } from "@glintai/composer/recipe-v2";
import { digest, writeNew } from "./recipe-files";
import { recipeFileHash, probeRecipeAsset } from "./recipe-assets";
import { recipeDrafts } from "./recipe-plan-v2";
import { recipeSceneProject } from "./recipe-projects";
type DesignModule = {
  prepareDesign: (
    document: unknown,
    options: { mediaAsset: (name: string) => string | undefined },
  ) => Promise<{ warnings: Set<string> }>;
};
type CaptureModule = {
  captureDesign: (
    prepared: unknown,
    document: unknown,
    format: string,
  ) => Promise<{ buffer: Uint8Array }>;
};

async function captureSlides(directory: string, plan: RecipePlanV2) {
  if (plan.input.recipeId !== "slides-video") return [];
  const modulePath = (name: string) =>
    pathToFileURL(fileURLToPath(new URL("../../web/server/" + name, import.meta.url))).href;
  const design: DesignModule = await import(modulePath("design-export-html.mjs"));
  const browser: CaptureModule = await import(modulePath("design-export-browser.mjs"));
  const files: string[] = [];
  for (const [index, page] of plan.input.content.document.pages.entries()) {
    const document = { ...plan.input.content.document, pages: [page], activePageId: page.id };
    const prepared = await design.prepareDesign(document, {
      mediaAsset: (name) => {
        const asset = plan.assets.find(
          (item) => item.kind === "image" && item.file === "assets/" + name,
        );
        return asset ? path.join(directory, asset.file) : undefined;
      },
    });
    if (prepared.warnings.size)
      throw new Error("Design capture requires review: " + [...prepared.warnings].join("; "));
    const captured = await browser.captureDesign(prepared, document, "png");
    const file = "assets/recipe-page-" + index + ".png";
    const fd = fs.openSync(path.join(directory, file), "wx");
    try {
      fs.writeFileSync(fd, captured.buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    probeRecipeAsset(path.join(directory, file), "image");
    files.push(file);
  }
  return files;
}
async function synthesizeVoices(directory: string, plan: RecipePlanV2) {
  if (plan.input.voice !== "sapi") return [];
  const project = recipeSceneProject(plan.input, plan.assets),
    provider = new SapiTtsProvider();
  const results: BoundRecipeAsset[] = [];
  for (const [index, scene] of project.scenes.entries()) {
    const result = await provider.synthesize({
      text: scene.narration.text,
      voice: plan.input.sapiVoice,
    });
    const file = "assets/recipe-voice-" + index + ".wav",
      target = path.join(directory, file);
    const fd = fs.openSync(target, "wx");
    try {
      fs.writeFileSync(fd, result.audio);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    results.push({
      id: "recipe-voice-" + index,
      kind: "audio",
      file,
      ...recipeFileHash(target),
      ...probeRecipeAsset(target, "audio"),
    });
  }
  return results;
}
export async function materializeApprovedRecipe(directory: string, plan: RecipePlanV2) {
  const slides = await captureSlides(directory, plan),
    voices = await synthesizeVoices(directory, plan);
  const drafts = recipeDrafts(plan.input, [...plan.assets, ...voices]);
  for (const item of drafts)
    writeNew(path.join(directory, item.file), JSON.stringify(item.project, null, 2));
  const files = [...drafts.map((item) => item.file), ...slides, ...voices.map((item) => item.file)];
  const receipt = {
    version: 1,
    adapter: "builtin-recipe-materialize-v2",
    inputDigest: plan.inputDigest,
    files: files.map((file) => ({ file, ...recipeFileHash(path.join(directory, file)) })),
    draftDigest: digest(JSON.stringify(drafts)),
    modelCalls: 0,
  };
  writeNew(path.join(directory, "materialize.receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
