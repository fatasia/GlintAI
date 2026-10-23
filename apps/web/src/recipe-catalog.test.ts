import { describe, expect, it } from "vitest";
import catalog from "./recipe-catalog.json";
import { TEMPLATES, THEME_IDS } from "@glintai/composer/templates";

describe("practical recipe catalog", () => {
  it("ships 100 unique, renderable starting points", () => {
    const recipes = catalog.recipes;
    expect(recipes).toHaveLength(100);
    expect(new Set(recipes.map(recipe => recipe.id)).size).toBe(100);
    expect(new Set(recipes.map(recipe => recipe.category)).size).toBeGreaterThanOrEqual(8);
    for (const recipe of recipes) {
      expect(recipe.title.trim()).not.toBe("");
      expect(recipe.description.trim().length).toBeGreaterThan(10);
      expect(TEMPLATES.some(template => template.id === recipe.template), recipe.template).toBe(true);
      expect(THEME_IDS).toContain(recipe.theme);
      expect(["16:9", "9:16", "1:1"]).toContain(recipe.aspect);
      expect(recipe.sample.trim().length).toBeGreaterThanOrEqual(20);
      expect(recipe.durationSec).toBeGreaterThanOrEqual(8);
    }
  });
});
