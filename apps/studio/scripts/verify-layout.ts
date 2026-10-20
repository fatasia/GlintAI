import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { parseProject, type AspectRatio } from "@glintai/scenescript";
const studio = fileURLToPath(new URL("../", import.meta.url));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-layout-check-"));
const phrase = "清晰的讲解需要保留上下文，并用具体问题串起每一个步骤。";
const narration = { text: phrase.repeat(4), durationMs: 2000 };
const scenes = [
  { id: "title", kind: "title", title: "当标题很长时：如何让复杂概念在不同画面比例中保持清晰、完整而且容易阅读", subtitle: "横屏、方屏与竖屏共用同一个内容合同", narration },
  { id: "definition", kind: "definition", term: "长段落的自适应排版", definition: phrase.repeat(6), narration },
  { id: "comparison", kind: "comparison", heading: "两种讲解方式的对比", left: { label: "保持上下文", points: [phrase, phrase, phrase] }, right: { label: "减少信息跳跃", points: [phrase, phrase, phrase] }, narration },
  { id: "diagram", kind: "diagram", heading: "五个步骤构成的解释路径", steps: ["提出问题", "寻找资料", "核对数字", "组织画面", "检查理解"].map((label) => ({ label, note: phrase })), narration },
  { id: "code", kind: "code", heading: "真实代码片段的显示区域", language: "typescript", code: Array.from({ length: 12 }, (_, i) => `const step${i + 1} = explain("${phrase}");`).join("\n"), narration },
  { id: "bullets", kind: "bullets", heading: "多条长要点", items: Array.from({ length: 4 }, (_, i) => `${i + 1} · ${phrase.repeat(2)}`), narration },
  { id: "quote", kind: "quote", text: phrase.repeat(3), attribution: "原创排版测试文字", narration },
];
const report: Record<string, unknown> = { status: "running", output: out, cases: [] };
const serveUrl = await bundle({ entryPoint: path.join(studio, "src/index.ts"), publicDir: path.join(studio, "public") });
const browser = await openBrowser("chrome");
try {
  for (const aspect of ["16:9", "9:16", "1:1"] as AspectRatio[]) {
    const project = parseProject({ schemaVersion: 1, id: "layout-stress", title: "Layout stress", aspect, fps: 24, theme: "cream-editorial", knowledgeSources: [], scenes });
    const inputProps = { project };
    const composition = await selectComposition({ serveUrl, id: "Glint", inputProps, puppeteerInstance: browser });
    for (const [index, scene] of project.scenes.entries()) {
      const file = path.join(out, `${aspect.replace(":", "x")}-${scene.id}.png`);
      await renderStill({ serveUrl, composition, inputProps, puppeteerInstance: browser, frame: index * 48 + 40, output: file });
      const png = fs.readFileSync(file);
      assert.equal(png.readUInt32BE(16), composition.width); assert.equal(png.readUInt32BE(20), composition.height);
      (report.cases as unknown[]).push({ aspect, scene: scene.kind, width: composition.width, height: composition.height, bytes: png.length, file });
    }
  }
  report.status = "rendered";
  console.log(`[verify-layout] 21 long-content stills rendered; inspect these before judging visual quality: ${out}`);
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally { await browser.close({ silent: true }); fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2)); }
