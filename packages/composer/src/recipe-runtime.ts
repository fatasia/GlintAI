import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RecipePlan = z
  .object({
    format: z.literal("glint-recipe-plan"),
    version: z.literal(1),
    recipeId: z.literal("source-explainer"),
    recipeVersion: z.literal("1.0.0"),
    visual: z.enum(["mg", "aigc"]),
    voice: z.enum(["existing", "sapi"]),
    inputDigest: hash,
    projectDigest: hash,
    stepsDigest: hash,
    quoteDigest: hash,
    quote: z
      .object({
        amount: z.literal("0").nullable(),
        unit: z.literal("CNY"),
        source: z.enum(["builtin-local-adapter", "unknown"]),
        scope: z.literal("model-service-fee-only"),
      })
      .strict(),
    steps: z
      .array(
        z
          .object({
            id: z.string(),
            tool: z.string(),
            args: z.array(z.string()),
            dependsOn: z.array(z.string()),
            outputs: z.array(z.string()),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type RecipePlan = z.infer<typeof RecipePlan>;
/** AIGC is a declared choice, not silently replaced with MG. */
export function requireExecutableRecipe(plan: RecipePlan): void {
  if (plan.visual !== "mg" || plan.quote.amount === null)
    throw new Error("AIGC execution is not connected; unknown paid effects are blocked");
}

export { requireTaskApproval } from "@glintai/models/task-approval";
