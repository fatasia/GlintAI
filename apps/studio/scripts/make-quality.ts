import fs from "node:fs";
import path from "node:path";
import { parseProject } from "@glintai/scenescript";
import { renderNative, type NativeRenderOptions } from "./native-render";
import { runQa, printQaReport } from "./qa";

/** One local, presentation-only retry. Never edits source facts or resubmits paid media. */
export async function renderWithQualityGate(options: NativeRenderOptions) {
  const first = await renderNative(options);
  let qa = await runQa(first.output); printQaReport(qa);
  fs.writeFileSync(`${first.output}.qa.json`, JSON.stringify(qa, null, 2));
  if (qa.verdict !== "red") return { ...first, qa, repaired: false };
  const failures = qa.gates.filter(g => g.level === "red");
  if (failures.some(g => !["richness", "static-span"].includes(g.id))) throw new Error(`Non-repairable QA failure; inspect ${first.output}.qa.json`);
  const preparedPath = `${first.output}.project.json`, project = parseProject(JSON.parse(fs.readFileSync(preparedPath, "utf8")));
  const changes: { sceneId: string; field: string; value: unknown }[] = [];
  for (const scene of project.scenes) {
    if (["html", "three", "video", "image"].includes(scene.kind)) continue;
    if (!scene.camera || scene.camera.type === "static") {
      scene.camera = { type: "drift", intensity: 0.5 };
      changes.push({ sceneId: scene.id, field: "camera", value: scene.camera });
    }
    if (!scene.transition) {
      scene.transition = { in: "fade", durationMs: 800 };
      changes.push({ sceneId: scene.id, field: "transition", value: scene.transition });
    }
  }
  if (!changes.length) throw new Error(`QA remains red and no safe automatic repair exists: ${first.output}.qa.json`);
  const repairPath = `${first.output}.qa-repair.project.json`;
  fs.writeFileSync(repairPath, JSON.stringify(project, null, 2), { flag: "wx" });
  fs.writeFileSync(`${first.output}.qa-repair.json`, JSON.stringify({ attempts: 1, changes, originalReport: `${first.output}.qa.json` }, null, 2), { flag: "wx" });
  const ext = path.extname(first.output), repairedOutput = first.output.slice(0, -ext.length) + `.repaired${ext}`;
  console.log("[glint] QA retry: presentation-only changes; original output retained");
  const result = await renderNative({ ...options, projectPath: repairPath, output: repairedOutput, tts: "existing" });
  qa = await runQa(result.output); printQaReport(qa);
  fs.writeFileSync(`${result.output}.qa.json`, JSON.stringify(qa, null, 2));
  if (qa.verdict === "red") throw new Error(`QA is still red after one bounded attempt; inspect ${result.output}.qa.json`);
  console.log(`[glint] accepted repaired output: ${result.output}`);
  return { ...result, qa, repaired: true };
}
