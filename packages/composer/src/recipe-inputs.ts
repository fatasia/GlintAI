import { z } from "zod";
import { SceneScriptProject } from "@glintai/scenescript";
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const text = z.string().min(1).max(4000);
const relative = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\:\0]/.test(value) &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Expected a safe relative local file",
  );
export const RecipeAssetInput = z
  .object({ id, file: relative, kind: z.enum(["image", "video", "audio"]) })
  .strict();
const audio = z
  .array(z.object({ sceneIndex: z.number().int().min(0).max(29), assetId: id }).strict())
  .max(30)
  .default([]);
const common = {
  format: z.literal("glint-recipe-input"),
  version: z.literal(1),
  visual: z.enum(["mg", "aigc", "existing"]),
  voice: z.enum(["existing", "sapi"]),
  assets: z.array(RecipeAssetInput).max(40),
  audio,
  sapiVoice: z.string().min(1).max(100).optional(),
};
const page = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    html: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024),
    notes: z.string().max(50000).optional(),
  })
  .strict();
export const RecipeDesignDocument = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    kind: z.enum(["page", "prototype", "slides"]),
    pages: z.array(page).min(1).max(10),
    activePageId: z.string(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export const RecipeInput = z.discriminatedUnion("recipeId", [
  z
    .object({
      ...common,
      recipeId: z.literal("source-explainer"),
      content: z.object({ markdown: z.string().min(1).max(64000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      recipeId: z.literal("product-promo"),
      content: z
        .object({
          productName: text,
          tagline: text,
          sellingPoints: z.array(text).length(3),
          productImage: id,
          price: z.string().max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      recipeId: z.literal("slides-video"),
      content: z
        .object({
          document: RecipeDesignDocument,
          pageDurationMs: z.number().int().min(500).max(30000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      recipeId: z.literal("longform-clips"),
      content: z
        .object({
          video: id,
          windows: z
            .array(
              z
                .object({
                  id,
                  title: text,
                  startMs: z.number().int().nonnegative(),
                  endMs: z.number().int().positive(),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      recipeId: z.literal("drama-two-shot"),
      content: z
        .object({
          title: text,
          shots: z
            .array(z.object({ title: text, narration: text, image: id, audio: id }).strict())
            .length(2),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      recipeId: z.literal("localized-voice"),
      content: z
        .object({
          project: SceneScriptProject,
          targetLanguage: z.string().min(2).max(30),
          translations: z
            .array(z.object({ sceneId: id, text }).strict())
            .min(1)
            .max(30),
        })
        .strict(),
    })
    .strict(),
]);
export type RecipeInput = z.infer<typeof RecipeInput>;
export type RecipeId = RecipeInput["recipeId"];
export function parseRecipeInput(value: unknown): RecipeInput {
  const input = RecipeInput.parse(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024)
    throw new Error("Recipe descriptor exceeds 8 MiB");
  const ids = input.assets.map((asset) => asset.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate asset identity");
  if (new Set(input.audio.map((item) => item.sceneIndex)).size !== input.audio.length)
    throw new Error("Duplicate narration index");
  if (input.voice === "sapi" && input.audio.length)
    throw new Error("Choose bound audio or explicit SAPI, not both");
  if (input.recipeId === "slides-video") {
    const doc = input.content.document,
      pageIds = doc.pages.map((page) => page.id);
    if (new Set(pageIds).size !== pageIds.length || !pageIds.includes(doc.activePageId))
      throw new Error("Design page identities must be unique and active page must exist");
    if (
      doc.pages.some((page) =>
        /<\s*(?:script|iframe|object|embed)\b|animation(?:-name|-duration)?\s*:/i.test(page.html),
      )
    )
      throw new Error("Recipe slides require static pages; remove scripts and CSS animation first");
  }
  return input;
}
