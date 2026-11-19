import { z } from "zod";
import { RecipePlan } from "./recipe-runtime";
import { RecipeInput } from "./recipe-inputs";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const BoundRecipeAsset = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    file: z
      .string()
      .regex(/^assets\/[a-z][a-z0-9-]{0,63}\.(png|jpg|jpeg|webp|wav|mp3|m4a|mp4|webm)$/),
    kind: z.enum(["image", "video", "audio"]),
    sha256: hash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    durationMs: z.number().finite().nonnegative(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    hasAudio: z.boolean().optional(),
  })
  .strict();
export const RecipePlanV2 = z
  .object({
    format: z.literal("glint-recipe-plan"),
    version: z.literal(2),
    recipeVersion: z.literal("2.0.0"),
    input: RecipeInput,
    assets: z.array(BoundRecipeAsset).max(40),
    inputDigest: hash,
    projectDigest: hash,
    stepsDigest: hash,
    quoteDigest: hash,
    quote: RecipePlan.shape.quote,
    steps: RecipePlan.shape.steps,
  })
  .strict();
export type RecipePlanV2 = z.infer<typeof RecipePlanV2>;
export type BoundRecipeAsset = z.infer<typeof BoundRecipeAsset>;
