// First-draft quality sample (CREATE-08): real model on the DEFAULT compose
// path (plain source, no approved plan) across three everyday inputs. Records
// the scene-kind distribution and whether every scene carries real visual
// content for its kind. Run with GLINT_LLM_* env; no credentials in this file.
//   pnpm --filter glint-studio exec tsx scripts/first-draft-quality.mjs --out=<evidenceDir>
import fs from "node:fs";
import path from "node:path";
import { composeWithLlm } from "@glintai/composer";
import { llmFromEnvironment } from "@glintai/llm";

const outDir = process.argv.find(arg => arg.startsWith("--out="))?.slice("--out=".length);
if (!outDir) { console.error("usage: first-draft-quality.mjs --out=<evidenceDir>"); process.exit(2); }
if (!process.env.GLINT_LLM_API_KEY) { console.error("GLINT_LLM_API_KEY is required"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const INPUTS = [
  { id: "product-promo", source: "# 咖啡店开业宣传\n\n## 要点\n- 周六上午 10 点开业\n- 手冲单品咖啡，豆子来自云南保山\n- 前 50 位到店送手冲一杯\n- 地址：南山路 22 号" },
  { id: "mechanism-explainer", source: "# 为什么飞机能飞起来\n\n## 机翼的原理\n机翼上表面弯曲，气流走过上表面的路径更长，速度更快，压强更低；下表面压强较高。压强差产生升力。\n\n## 起飞与降落\n起飞时襟翼放下增加升力；降落时襟翼也放下，同时减速。" },
  { id: "data-report", source: "# 季度能耗报告\n\n## 数据\n一季度用电 12,400 度，二季度 9,800 度，三季度 11,200 度。光伏自发自用比例从 18% 升到 31%。\n\n## 结论\n夏季空调负荷下降抵消了光伏波动，全年预计节电 8%。" },
];

function visualContentOf(scene) {
  switch (scene.kind) {
    case "title": return Boolean(scene.title);
    case "bullets": return scene.items.length > 0;
    case "definition": return Boolean(scene.term && scene.definition);
    case "quote": return Boolean(scene.text);
    case "comparison": return scene.left.points.length > 0 && scene.right.points.length > 0;
    case "code": return Boolean(scene.code);
    case "chart": return scene.data.length > 0;
    case "diagram": return scene.steps.length >= 2;
    case "image": case "video": return Boolean(scene.src);
    case "html": case "three": return false; // restricted kinds, not expected on this path
  }
}

const llm = llmFromEnvironment();
const results = [];
for (const input of INPUTS) {
  const startedAt = Date.now();
  const project = await composeWithLlm(input.source, llm, { projectId: `quality-${input.id}` });
  const scenes = project.scenes.map(scene => ({ id: scene.id, kind: scene.kind, hasVisualContent: visualContentOf(scene) }));
  const kinds = [...new Set(scenes.map(scene => scene.kind))];
  results.push({ id: input.id, ms: Date.now() - startedAt, kinds, scenes,
    allScenesHaveVisualContent: scenes.every(scene => scene.hasVisualContent) });
  fs.writeFileSync(path.join(outDir, `${input.id}.project.json`), JSON.stringify(project, null, 2));
  console.log(`${input.id}: ${kinds.join(",")} visual=${results.at(-1).allScenesHaveVisualContent} (${results.at(-1).ms}ms)`);
}

const report = {
  ranAt: new Date().toISOString(), model: process.env.GLINT_LLM_MODEL ?? "(default)",
  inputs: INPUTS.map(input => input.id), results,
  kindDiversity: results.map(result => ({ id: result.id, distinctKinds: result.kinds.length, kinds: result.kinds })),
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const visualFailure = results.find(result => !result.allScenesHaveVisualContent);
console.log(visualFailure ? `FAIL ${visualFailure.id} has scenes without visual content` : `PASS evidence written to ${path.resolve(outDir)}`);
process.exitCode = visualFailure ? 1 : 0;
