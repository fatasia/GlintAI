import fs from "node:fs";
import path from "node:path";
import { parseProject } from "@glintai/scenescript";
import type { TaskPlan } from "./agent-tasks";

/** One source of truth for CLI and skill plans. Media validation belongs to rendering, not a guessed README. */
export function buildProjectPlan(projectPath: string, options: { tts?: string; music?: string; fast?: boolean; resolution?: string; deck?: boolean; review?: boolean; feedback?: string } = {}): TaskPlan {
  const absolute = path.resolve(projectPath), file = path.basename(absolute);
  const project = parseProject(JSON.parse(fs.readFileSync(absolute, "utf8"))), output = `${project.id}.mp4`;
  const steps: TaskPlan["steps"] = [{ id: "lint", tool: "lint", args: [`--project=${file}`, `--out=${project.id}.lint.json`, "--strict"], dependsOn: [], outputs: [`${project.id}.lint.json`] }];
  let renderProject = file, dependency = "lint";
  if (options.review || options.feedback) {
    renderProject = `${project.id}.reviewed.json`;
    steps.push({ id: "review", tool: "review", args: [`--project=${file}`, `--out=${renderProject}`, ...(options.feedback ? [`--feedback=${options.feedback}`] : [])], dependsOn: [dependency], outputs: [renderProject, `${renderProject}.review.json`] });
    steps.push({ id: "review-lint", tool: "lint", args: [`--project=${renderProject}`, `--out=${project.id}.reviewed.lint.json`, "--strict"], dependsOn: ["review"], outputs: [`${project.id}.reviewed.lint.json`] });
    dependency = "review-lint";
  }
  steps.push(
    { id: "render", tool: "render-native", args: [`--project=${renderProject}`, `--out=${output}`, ...(options.tts ? [`--tts=${options.tts}`] : []), ...(options.music ? [`--music=${options.music}`] : []), ...(options.fast ? ["--fast"] : []), ...(options.resolution ? [`--resolution=${options.resolution}`] : [])], dependsOn: [dependency], outputs: [output, `${output}.project.json`] },
    { id: "qa", tool: "qa", args: [`--video=${output}`, `--out=${project.id}.qa.json`, "--strict"], dependsOn: ["render"], outputs: [`${project.id}.qa.json`] },
  );
  if (options.deck) steps.push({ id: "deck", tool: "deck", args: [`--project=${output}.project.json`, `--out=${project.id}-deck`], dependsOn: ["qa"], outputs: [`${project.id}-deck/index.html`] });
  return { version: 1, title: `讲解生产线:${project.title}`, steps };
}
