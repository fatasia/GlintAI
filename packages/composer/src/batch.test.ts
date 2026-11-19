import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { validateBatchTable, applyTemplate, estimateBatchBudget, scheduleBatch, resumeBatch, runChunked, applyBatchAssets, expandSceneGroups } from "./batch";
import { VideoPlan } from "./plan";

const TABLE = [
  "商品名,卖点,素材,id",
  "手冲壶,|细口稳定水流|304不锈钢,hero.mp4,pot-01",
  "咖啡豆,|云南日晒|中浅焙,,bean-01",
  "手冲壶,|重复行,,pot-01",
  "无卖点壶,,,pot-03",
].join("\n");

const template = VideoPlan.parse({
  title: "{{name}} 上新", hook: "{{卖点1}}，一眼心动", audience: "咖啡爱好者", platform: "9:16",
  theme: "mint-clean", totalSeconds: 12, takeaway: "到店试试 {{name}}",
  scenes: [
    { goal: "展示 {{name}}", narration: "这支 {{name}}，{{卖点1}}。", visual: "{{素材1}} 特写", seconds: 6, kind: "bullets" },
    { goal: "收束", narration: "今天开始 {{卖点2}}。", visual: "落版 {{name}}", seconds: 6, kind: "title" },
  ],
});

describe("commercial batch (S07 independent implementation)", () => {
  it("validates a product table with Chinese headers and list cells", () => {
    const { rows, issues } = validateBatchTable(TABLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "pot-01", name: "手冲壶", sellingPoints: ["细口稳定水流", "304不锈钢"], assets: ["hero.mp4"], assetPrompt: "" });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ row: 4, column: "id", message: /重复/ });
    expect(issues[1]).toMatchObject({ row: 5, column: "sellingPoints" });
  });
  it("reports missing asset files per row without blocking the rest", () => {
    const { rows, issues } = validateBatchTable(TABLE, { assetExists: asset => asset !== "hero.mp4" });
    expect(rows).toHaveLength(2);
    expect(issues.some(issue => issue.row === 2 && issue.column === "assets" && issue.message === "素材不存在：hero.mp4")).toBe(true);
  });
  it("rejects a table without the required headers", () => {
    const { rows, issues } = validateBatchTable("a,b\n1,2");
    expect(rows).toHaveLength(0);
    expect(issues[0]!.message).toContain("缺少必需列");
  });
  it("fills a template plan per row and reports unknown variables", () => {
    const { plan, warnings } = applyTemplate(template, { id: "pot-01", name: "手冲壶", sellingPoints: ["细口稳定水流", "304不锈钢"], assets: ["hero.mp4"], assetPrompt: "" });
    expect(plan.title).toBe("手冲壶 上新");
    expect(plan.scenes[0]!.narration).toBe("这支 手冲壶，细口稳定水流。");
    expect(plan.scenes[1]!.narration).toBe("今天开始 304不锈钢。");
    expect(plan.takeaway).toBe("到店试试 手冲壶");
    expect(warnings).toEqual([]);
    const bad = applyTemplate(template, { id: "x", name: "N", sellingPoints: ["卖点"], assets: [], assetPrompt: "" });
    expect(bad.warnings.some(warning => warning.includes("未知变量 {{sku}}"))).toBe(false);
    const unknown = applyTemplate({ ...template, hook: "{{sku}} 上新" }, { id: "x", name: "N", sellingPoints: ["卖点"], assets: [], assetPrompt: "" });
    expect(unknown.warnings.join()).toContain("未知变量 {{sku}}");
    expect(unknown.plan.hook).toContain("{{sku}}");
  });
});

describe("batch trial budget, concurrency and resume (BATCH-03/04/05)", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("estimates trial budget from per-second and per-call pricing", () => {
    const budget = estimateBatchBudget(rows, { planSeconds: 12, pricing: { perSecond: 0.13, perCall: 0.61 } });
    expect(budget).toMatchObject({ rows: 3, perRow: 12 * 0.13 + 0.61, total: 3 * (12 * 0.13 + 0.61), currency: "算力", basis: "网关报价，实际以账单为准" });
    expect(() => estimateBatchBudget(rows, { pricing: {} })).toThrow(/定价缺失/);
  });
  it("caps concurrency in chunks and drops duplicate submission keys once", () => {
    const { chunks, duplicates } = scheduleBatch([...rows, { id: "a" }], { maxConcurrent: 2, keyOf: row => row.id });
    expect(chunks).toEqual([[{ id: "a" }, { id: "b" }], [{ id: "c" }]]);
    expect(duplicates).toEqual([{ item: { id: "a" }, key: "a" }]);
    expect(scheduleBatch(rows, { maxConcurrent: 0, keyOf: row => row.id }).chunks).toHaveLength(3);
  });
  it("resumes a partially failed batch without redoing finished rows", () => {
    const { todo, done } = resumeBatch(rows, { isDone: row => row.id !== "b" });
    expect(done.map(row => row.id)).toEqual(["a", "c"]);
    expect(todo).toEqual([{ id: "b" }]);
  });
});

describe("batch executor primitive", () => {
  it("runs chunks with in-chunk concurrency and keeps per-item failures", async () => {
    const order: string[] = [];
    const results = await runChunked([["a", "b"], ["c"]], async item => {
      if (item === "b") { order.push("b-start"); await new Promise(resolve => setTimeout(resolve, 20)); order.push("b-end"); return `ok-${item}`; }
      if (item === "c") throw new Error("boom");
      order.push(item);
      return `ok-${item}`;
    });
    expect(results).toEqual([
      { item: "a", ok: true, value: "ok-a" },
      { item: "b", ok: true, value: "ok-b" },
      { item: "c", ok: false, error: "boom" },
    ]);
    // a and b run concurrently inside a chunk; c waits for the chunk boundary.
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b-end"));
    expect(order).toEqual(["a", "b-start", "b-end"]);
  });
});

describe("batch asset binding (BATCH×GEN bridge)", () => {
  const composed = parseProject({
    schemaVersion: 1, id: "b", title: "批量", aspect: "16:9", knowledgeSources: [],
    scenes: [
      { id: "s1", kind: "bullets", heading: "卖点", items: ["a"], narration: { text: "第一段", durationMs: 3000 }, notes: "画面：{{素材1}} 特写" },
      { id: "s2", kind: "bullets", heading: "落版", items: ["b"], narration: { text: "第二段", durationMs: 3000 } },
      { id: "s3", kind: "bullets", heading: "缺素材", items: ["c"], narration: { text: "第三段", durationMs: 3000 }, notes: "画面：{{素材2}}" },
    ],
  });
  it("binds a resolved asset as an image scene, keeping narration", () => {
    const { project, bound } = applyBatchAssets(composed, ["hero.jpg"], { copyAsset: () => "assets/pot-01-1.jpg" });
    expect(bound).toBe(1);
    const bound0 = project.scenes[0]!;
    expect(bound0.kind).toBe("image");
    expect(bound0.kind === "image" && bound0.src).toBe("assets/pot-01-1.jpg");
    expect(bound0.narration.text).toBe("第一段");
    expect(bound0.kind === "image" && bound0.caption).toBe("画面： 特写");
    // Untouched scenes keep their kind; the unresolved placeholder never binds.
    expect(project.scenes[1]!.kind).toBe("bullets");
    expect(project.scenes[2]!.kind).toBe("bullets");
  });
  it("is a no-op without placeholders or assets", () => {
    expect(applyBatchAssets(composed, []).bound).toBe(0);
    expect(applyBatchAssets(parseProject({ schemaVersion: 1, id: "c", title: "T", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "T", narration: { text: "x", durationMs: 1000 } }] }), ["a.jpg"]).bound).toBe(0);
  });
});

describe("scene-group variants (BATCH-02)", () => {
  const row = { id: "pot", name: "手冲壶", sellingPoints: ["细口水流", "304不锈钢", "滴漏两用"], assets: [], assetPrompt: "" };
  const groupTemplate = VideoPlan.parse({
    title: "{{name}}", hook: "h", audience: "a", platform: "9:16", theme: "mint-clean", totalSeconds: 18, takeaway: "t",
    scenes: [
      { goal: "开场", narration: "开场白。", visual: "v", seconds: 4, kind: "title" },
      { goal: "[卖点] 展示", narration: "第 {{卖点序号}} 点：{{卖点}}。", visual: "{{卖点}} 的画面", seconds: 4, kind: "bullets" },
      { goal: "收束", narration: "结束。", visual: "v", seconds: 4, kind: "title" },
    ],
  });
  it("expands the marked group into one scene per selling point", () => {
    const expanded = expandSceneGroups(groupTemplate, row);
    expect(expanded.scenes).toHaveLength(5);
    expect(expanded.scenes[1]).toMatchObject({ goal: "展示", narration: "第 1 点：细口水流。" });
    expect(expanded.scenes[3]!.narration).toBe("第 3 点：滴漏两用。");
    expect(expanded.totalSeconds).toBe(20);
    // The group marker never leaks into the copy.
    expect(JSON.stringify(expanded.scenes)).not.toContain("[卖点]");
  });
  it("leaves a group-free template untouched", () => {
    expect(expandSceneGroups(groupTemplate, { ...row, sellingPoints: ["唯一卖点"] }).scenes).toHaveLength(3);
    const plain = VideoPlan.parse({ ...groupTemplate, scenes: groupTemplate.scenes.map(scene => ({ ...scene, goal: scene.goal.replace("[卖点] ", "") })) });
    expect(expandSceneGroups(plain, row)).toBe(plain);
  });
});
