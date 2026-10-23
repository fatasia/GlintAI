#!/usr/bin/env node
/**
 * Recipe thumbnails: render the first scene of every recipe-catalog entry to a
 * 320x180 PNG via the native SVG renderer (no browser, no Remotion), so the
 * template gallery shows real pixels instead of text-only cards.
 *
 * Usage: pnpm --filter glint-studio exec tsx ../../scripts/generate-recipe-thumbs.mjs [--only=id,id]
 * Output: apps/web/public/recipes/<id>.png + apps/web/src/recipe-thumbs.json (manifest)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const studioRequire = createRequire(path.join(ROOT, "apps", "studio", "package.json"));
const { Resvg } = studioRequire("@resvg/resvg-js");
const { composeFromMarkdown } = await import(pathToFileURL(path.join(ROOT, "packages", "composer", "src", "index.ts")).href);
const { renderSceneSvg } = await import(pathToFileURL(path.join(ROOT, "apps", "studio", "scripts", "native-svg", "index.ts")).href);
const OUT_DIR = path.join(ROOT, "apps", "web", "public", "recipes");
const MANIFEST = path.join(ROOT, "apps", "web", "src", "recipe-thumbs.json");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "web", "src", "recipe-catalog.json"), "utf8"));
const args = process.argv.slice(2);
const only = args.find(arg => arg.startsWith("--only="))?.slice(7).split(",").filter(Boolean);

fs.mkdirSync(OUT_DIR, { recursive: true });
const entries = [];
let failures = 0;
for (const recipe of catalog.recipes) {
  if (only && !only.includes(recipe.id)) continue;
  const output = path.join(OUT_DIR, `${recipe.id}.png`);
  try {
        let project;
    try {
      project = composeFromMarkdown(recipe.sample, { projectId: `thumb-${recipe.id}`, template: recipe.template, theme: recipe.theme, aspect: recipe.aspect, maxScenes: 4 });
    } catch {
      // Some templates need structured sources (dates, steps); the thumbnail previews the visual style instead.
      project = composeFromMarkdown(recipe.sample, { projectId: `thumb-${recipe.id}`, template: "explainer", theme: recipe.theme, aspect: recipe.aspect, maxScenes: 4 });
    }
    const svg = renderSceneSvg(project, project.scenes[0], 12, { width: 320, height: 180 });
    fs.writeFileSync(output, new Resvg(svg, { fitTo: { mode: "width", value: 320 } }).render().asPng());
    entries.push({ id: recipe.id, thumb: `/recipes/${recipe.id}.png` });
  } catch (error) {
    failures++;
    console.error(`[recipe-thumbs] ${recipe.id}: ${error instanceof Error ? error.message : error}`);
  }
}
fs.writeFileSync(MANIFEST, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entries }, null, 2));
console.log(`[recipe-thumbs] ${entries.length} rendered, ${failures} failed → ${path.relative(ROOT, MANIFEST)}`);
