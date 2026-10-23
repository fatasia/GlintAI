import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { parseProject, buildTimeline, timelineToFrames } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { renderSceneSvg } from "../apps/studio/scripts/native-svg/index.ts";
import { createTextOutliner } from "../apps/studio/scripts/native-svg/outline.ts";

/**
 * Renders real stills from bundled example projects for the workbench gallery.
 * No browser and no model calls: the SVG scene renderer is the same one the
 * native export uses, so these are frames of actual Glint output.
 */
const repo = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repo, "apps/web/public/showcase");
fs.mkdirSync(outputDir, { recursive: true });
const fontFiles = process.platform === "win32"
  ? ["msyh.ttc", "msyhbd.ttc", "simkai.ttf", "consola.ttf"].map(name => path.join(process.env.WINDIR ?? "C:/Windows", "Fonts", name)).filter(file => fs.existsSync(file))
  : [];
const jobs = [
  { project: "examples/entropy-lecture/project.scenescript.json", scene: "second-law", frame: 18, name: "entropy-second-law" },
  { project: "examples/entropy-lecture/project.scenescript.json", scene: "intro", frame: 24, name: "entropy-intro" },
  { project: "examples/uncertainty-principle/project.scenescript.json", scene: undefined, frame: 24, name: "uncertainty-intro" },
] as const;
for (const job of jobs) {
  const project = parseProject(JSON.parse(fs.readFileSync(path.join(repo, job.project), "utf8")));
  const { entries } = timelineToFrames(buildTimeline(project), project.fps ?? 30);
  const sceneId = job.scene ?? project.scenes[0]!.id;
  const entry = entries.find(item => item.scene.id === sceneId);
  if (!entry) throw new Error(`Unknown scene ${sceneId}`);
  const width = 1280, height = 720;
  const svg = renderSceneSvg(project, entry.scene, Math.min(job.frame, Math.max(0, entry.duration - 1)), { width, height });
  const outline = createTextOutliner({ loadSystemFonts: fontFiles.length === 0, fontFiles, defaultFontFamily: "Microsoft YaHei" }, width, height, resolveTheme(project.theme).fonts.body);
  const png = new Resvg(outline(svg), { font: { loadSystemFonts: false } }).render().asPng();
  const file = path.join(outputDir, `${job.name}.png`);
  fs.writeFileSync(file, png);
  console.log(`${job.name}: ${width}x${height} ${png.length} bytes → ${path.relative(repo, file)}`);
}
