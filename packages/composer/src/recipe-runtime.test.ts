import { expect, it } from "vitest";
import { RecipePlan, requireExecutableRecipe } from "./recipe-runtime";
it("keeps versioned recipe structure strict and AIGC blocked without a paid adapter", () => {
  const hash = "a".repeat(64),
    local = RecipePlan.parse({
      format: "glint-recipe-plan",
      version: 1,
      recipeId: "source-explainer",
      recipeVersion: "1.0.0",
      visual: "mg",
      voice: "existing",
      inputDigest: hash,
      projectDigest: hash,
      stepsDigest: hash,
      quoteDigest: hash,
      quote: {
        amount: "0",
        unit: "CNY",
        source: "builtin-local-adapter",
        scope: "model-service-fee-only",
      },
      steps: [{ id: "lint", tool: "lint", args: [], dependsOn: [], outputs: ["lint.json"] }],
    });
  expect(() => requireExecutableRecipe(local)).not.toThrow();
  expect(() => requireExecutableRecipe({ ...local, visual: "aigc" })).toThrow("unknown");
  expect(() => RecipePlan.parse({ ...local, version: 2 })).toThrow();
  expect(() => RecipePlan.parse({ ...local, allowUnknown: true })).toThrow();
});
