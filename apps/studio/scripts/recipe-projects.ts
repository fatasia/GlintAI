import { composeFromMarkdown } from "@glintai/composer";
import { instantiateCreationPack } from "@glintai/composer/creation-packs";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import type { RecipeInput } from "@glintai/composer/recipe-inputs";
import type { BoundRecipeAsset } from "@glintai/composer/recipe-v2";
import { clipProjectToNle } from "./longform-clip-edit";
import { buildDramaTimeline } from "./drama-timeline";
export function recipeAsset(
  assets: BoundRecipeAsset[],
  id: string,
  kind?: BoundRecipeAsset["kind"],
) {
  const value = assets.find((asset) => asset.id === id);
  if (!value || (kind && value.kind !== kind))
    throw new Error("Missing or wrong-kind bound asset: " + id);
  return value;
}
function localizable(project: SceneScriptProject, assets: BoundRecipeAsset[]) {
  if (
    project.music ||
    project.sfx?.length ||
    project.assets?.length ||
    typeof project.theme !== "string"
  )
    throw new Error("Unsupported source project resources");
  for (const scene of project.scenes) {
    if (
      ["html", "three"].includes(scene.kind) ||
      scene.elements?.length ||
      scene.sharedElements?.length ||
      scene.assetRefs?.length
    )
      throw new Error("Executable/overlay scenes are not supported by this adapter");
    if (
      (scene.kind === "image" || scene.kind === "video") &&
      !assets.some((a) => a.file === scene.src && a.kind === scene.kind)
    )
      throw new Error("Project visual is not a bound asset");
  }
  return project;
}
function localized(
  input: Extract<RecipeInput, { recipeId: "localized-voice" }>,
  assets: BoundRecipeAsset[],
) {
  const project = localizable(parseProject(input.content.project), assets),
    translations = input.content.translations;
  if (
    project.language === input.content.targetLanguage ||
    translations.length !== project.scenes.length ||
    new Set(translations.map((t) => t.sceneId)).size !== translations.length
  )
    throw new Error("Target language and complete unique translations are required");
  let changed = false;
  const scenes = project.scenes.map((scene) => {
    const item = translations.find((t) => t.sceneId === scene.id);
    if (!item) throw new Error("Missing translated scene");
    changed ||= item.text !== scene.narration.text;
    return {
      ...scene,
      narration: {
        ...scene.narration,
        text: item.text,
        audioRef: undefined,
        audioOffsetMs: undefined,
        segments: undefined,
        voice: input.sapiVoice,
      },
    };
  });
  if (!changed) throw new Error("Unchanged source text is not a confirmed translation");
  if (input.voice === "existing" && input.audio.length !== scenes.length)
    throw new Error("Localized voice requires bound audio for every translated scene");
  return parseProject({ ...project, id: "recipe", language: input.content.targetLanguage, scenes });
}
function product(
  input: Extract<RecipeInput, { recipeId: "product-promo" }>,
  assets: BoundRecipeAsset[],
) {
  const value = input.content,
    image = recipeAsset(assets, value.productImage, "image");
  const { project } = instantiateCreationPack(
    "product-launch",
    {
      productName: value.productName,
      tagline: value.tagline,
      sellingPoint1: value.sellingPoints[0]!,
      sellingPoint2: value.sellingPoints[1]!,
      sellingPoint3: value.sellingPoints[2]!,
      price: value.price ?? "",
    },
    { projectId: "recipe" },
  );
  return parseProject({
    ...project,
    scenes: [
      {
        id: "product-photo",
        kind: "image",
        presentation: "showcase",
        camera: { type: "push", intensity: 0.8 },
        src: image.file,
        caption: value.productName,
        narration: { text: value.tagline, durationMs: 2000 },
      },
      ...project.scenes,
    ],
  });
}
function slides(input: Extract<RecipeInput, { recipeId: "slides-video" }>) {
  const doc = input.content.document;
  return parseProject({
    schemaVersion: 1,
    id: "recipe",
    title: doc.title,
    language: "zh-CN",
    aspect: "16:9",
    fps: 24,
    theme: "glint-dark",
    knowledgeSources: [],
    scenes: doc.pages.map((page, index) => ({
      id: "slide-" + index,
      kind: "image",
      presentation: "slide",
      src: "assets/recipe-page-" + index + ".png",
      caption: page.title,
      notes: page.notes ?? "",
      ...(index > 0 ? { transition: { in: "fade", durationMs: 300 } } : {}),
      narration: {
        text: page.notes?.trim() || page.title,
        durationMs: input.content.pageDurationMs,
      },
    })),
  });
}
export function recipeSceneProject(input: RecipeInput, assets: BoundRecipeAsset[]) {
  let project: SceneScriptProject;
  if (input.recipeId === "source-explainer")
    project = composeFromMarkdown(input.content.markdown, {
      projectId: "recipe",
      maxScenes: 6,
      sourceName: "input.json",
    });
  else if (input.recipeId === "product-promo") project = product(input, assets);
  else if (input.recipeId === "slides-video") project = slides(input);
  else if (input.recipeId === "localized-voice") project = localized(input, assets);
  else throw new Error("Recipe uses NLE rather than scene project");
  if (input.audio.some((a) => a.sceneIndex >= project.scenes.length))
    throw new Error("Narration index exceeds scene count");
  project.scenes = project.scenes.map((scene, index) => {
    const binding = input.audio.find((a) => a.sceneIndex === index);
    const audio = binding
      ? recipeAsset(assets, binding.assetId, "audio")
      : input.voice === "sapi"
        ? assets.find((a) => a.id === "recipe-voice-" + index)
        : undefined;
    return {
      ...scene,
      narration: {
        ...scene.narration,
        voice: input.sapiVoice,
        audioRef: audio?.file,
        durationMs: audio?.durationMs ?? scene.narration.durationMs ?? 2000,
      },
    };
  });
  return parseProject(project);
}
export function recipeClipProjects(
  input: Extract<RecipeInput, { recipeId: "longform-clips" }>,
  assets: BoundRecipeAsset[],
) {
  const asset = recipeAsset(assets, input.content.video, "video"),
    ids = new Set<string>();
  return input.content.windows.map((window) => {
    if (ids.has(window.id) || window.startMs >= window.endMs || window.endMs > asset.durationMs)
      throw new Error("Invalid or duplicate source window");
    ids.add(window.id);
    const project = parseProject({
      schemaVersion: 1,
      id: window.id,
      title: window.title,
      aspect: "16:9",
      fps: 24,
      theme: "glint-dark",
      knowledgeSources: [],
      scenes: [
        {
          id: "clip",
          kind: "video",
          src: asset.file,
          trimStartSec: window.startMs / 1000,
          trimEndSec: window.endMs / 1000,
          narration: { text: window.title, durationMs: window.endMs - window.startMs },
          notes: "Source window " + window.startMs + ".." + window.endMs,
        },
      ],
    });
    const nle = clipProjectToNle({
      project,
      sourceWindow: window,
      width: asset.width,
      height: asset.height,
      fps: 24,
    }).nle;
    if (asset.hasAudio === false)
      for (const track of nle.tracks)
        for (const clip of track.clips) if (clip.kind === "video") clip.volume = 0;
    return {
      id: window.id,
      source: project,
      nle,
    };
  });
}
export function recipeDramaProject(
  input: Extract<RecipeInput, { recipeId: "drama-two-shot" }>,
  assets: BoundRecipeAsset[],
) {
  const shots = input.content.shots,
    audio = shots.map((s) => recipeAsset(assets, s.audio, "audio"));
  shots.forEach((s) => recipeAsset(assets, s.image, "image"));
  const result = buildDramaTimeline(
    {
      title: input.content.title,
      hook: shots[0]!.title,
      audience: "Confirmed audience",
      platform: "16:9",
      theme: "glint-dark",
      totalSeconds: audio.reduce((sum, a) => sum + a.durationMs / 1000, 0),
      takeaway: input.content.title,
      scenes: shots.map((s, i) => ({
        goal: s.title,
        visual: s.title,
        kind: "image",
        narration: s.narration,
        seconds: audio[i]!.durationMs / 1000,
      })),
    },
    { id: "recipe-drama", sceneAudioMs: audio.map((a) => a.durationMs) },
  );
  result.project.width = 960;
  result.project.height = 540;
  for (const track of result.project.tracks)
    track.clips.forEach((clip, index) => {
      if (clip.kind === "image") clip.src = recipeAsset(assets, shots[index]!.image, "image").file;
      if (clip.kind === "audio") clip.src = audio[index]!.file;
    });
  return result.project;
}
