import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MockLlmProvider } from "@glintai/llm";
import { buildTimeline, parseProject } from "@glintai/scenescript";
import { composeWithLlm } from "./llm";
import { VideoPlan } from "./plan";

/**
 * CREATE-04 fixture: compose a real project OFFLINE (MockLlmProvider, no
 * gateway, no paid API) from an approved plan, then drop it on disk for the
 * real low-cost preview render (mock TTS + local Chrome/ffmpeg CLI render +
 * browser playback check, run from the acceptance record).
 */

const plan = VideoPlan.parse({
  title: "咖啡店开业试片", hook: "这条街最香的开业", audience: "周边居民与上班族", platform: "16:9", theme: "glint-dark", totalSeconds: 12, takeaway: "周六来喝第一杯",
  scenes: [
    { goal: "开场钩子", narration: "这条街最香的开业，就在周六。", visual: "门店外观，人流", seconds: 3, kind: "title", layout: "center-stack", relation: "none", motion: "zoom-in" },
    { goal: "核心卖点", narration: "手冲咖啡，前五十位到店送一杯。", visual: "咖啡师冲煮特写，两个卖点字卡", seconds: 4, kind: "bullets", layout: "grid-2", relation: "hierarchy", motion: "reveal" },
    { goal: "地址信息", narration: "南山路二十二号，周六上午十点。", visual: "手绘地图路径逐步显现", seconds: 3, kind: "diagram", layout: "grid-2", relation: "flow", motion: "reveal" },
    { goal: "收束", narration: "周六见。", visual: "招牌与到店礼提示居中", seconds: 2, kind: "quote", layout: "center-stack", relation: "none", motion: "zoom-out" },
  ],
});

// The mock stands in for the model: same contract, zero cost, fully offline.
const reply = {
  schemaVersion: 1, id: "preview", title: "模型标题会被覆盖", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "hook", kind: "title", title: "被覆盖的标题", narration: { text: "被覆盖" } },
    { id: "benefits", kind: "bullets", heading: "被覆盖", items: ["被覆盖一", "被覆盖二"], narration: { text: "被覆盖" } },
    { id: "route", kind: "diagram", heading: "被覆盖", steps: [{ label: "到店" }, { label: "点单" }], narration: { text: "被覆盖" } },
    { id: "close", kind: "quote", text: "被覆盖", narration: { text: "被覆盖" } },
  ],
};

it("composes the approved plan offline and stages it for the real preview render", async () => {
  const project = await composeWithLlm("ignored", new MockLlmProvider(() => JSON.stringify(reply)), { projectId: "storyboard-preview" }, { approvedPlan: plan });
  // The approved storyboard survives composition byte for byte.
  expect(project.title).toBe(plan.title);
  expect(project.scenes.map(scene => scene.kind)).toEqual(["title", "bullets", "diagram", "quote"]);
  expect(project.scenes.map(scene => scene.narration.text)).toEqual(plan.scenes.map(scene => scene.narration));
  expect(buildTimeline(parseProject(JSON.parse(JSON.stringify(project)))).totalMs).toBe(12000);
  // CREATE-08 visual layer reached the render structure (grid-2 dividers + flow baseline).
  expect(project.scenes[1]!.elements?.some(element => element.id === "layout-anchor-1")).toBe(true);
  expect(project.scenes[2]!.elements?.some(element => element.id === "relation-baseline")).toBe(true);
  const outDir = path.resolve(__dirname, "../../../evidence/CREATE-04/run-20261025b");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "preview.project.json"), JSON.stringify(project, null, 2));
  fs.writeFileSync(path.join(outDir, "preview.plan.json"), JSON.stringify(plan, null, 2));
  expect(fs.existsSync(path.join(outDir, "preview.project.json"))).toBe(true);
});
