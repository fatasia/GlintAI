// Portions derived from OpenMotion (nexu-io/openmotion) openmotion-recreate skill, Apache-2.0. Modifications: rewritten for Glint CLI and zh-CN.

import { afterAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeReference, buildRecreatePlan, formatReviewTable, medianShotMs, parseKeepReplaceTable, quantizeFramePalette, recreateReviewTable, runAnalyzeReference, runRecreatePlan, type KeepReplaceRow } from "./recreate";

const run = promisify(execFile);

// 真实 ffmpeg 测试沿 nle-alpha.test 的 available 门模式：本机无 ffmpeg/ffprobe 时整组跳过。
let available = true;
try {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) available = false;
  if (spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status !== 0) available = false;
} catch { available = false; }

const roots: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-recreate-test-")); roots.push(dir); return dir; }
afterAll(async () => { for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }); });

/** 合成参考片：纯色段拼接，每段 2 秒、160x90、20fps → 三镜约 6 秒，切点在 2s/4s。 */
async function synthetic(dir: string, colors = ["red", "blue", "0x00ff00"], seconds = 2): Promise<string> {
  const file = path.join(dir, "reference.mp4");
  const inputs = colors.flatMap(color => ["-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=20:d=${seconds}`]);
  await run("ffmpeg", ["-nostdin", "-v", "error", ...inputs, "-filter_complex",
    `${colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", file]);
  return file;
}

const hexChannels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const near = (hex: string, expected: readonly [number, number, number], tolerance = 28) => {
  const channels = hexChannels(hex);
  return channels.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);
};

describe("数字测量 analyzeReference（真实 ffmpeg）", () => {
  it.skipIf(!available)("把三色合成片切成三镜，调色板对准各段纯色", async () => {
    const dir = await root(), video = await synthetic(dir);
    const measurement = await analyzeReference(video);
    expect(measurement.format).toBe("glint-reference-measurement");
    expect(measurement.inferred).toBe(true);
    expect(measurement.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(measurement.durationMs).toBeGreaterThan(5700);
    expect(measurement.durationMs).toBeLessThan(6300);
    expect(measurement.fps).toBeCloseTo(20, 0);
    expect(measurement.shots).toHaveLength(3);
    expect(measurement.shots[0]!.startMs).toBe(0);
    expect(measurement.shots.at(-1)!.endMs).toBe(measurement.durationMs);
    for (let index = 1; index < measurement.shots.length; index++) {
      expect(measurement.shots[index]!.startMs).toBe(measurement.shots[index - 1]!.endMs);
      expect(measurement.shots[index]!.durationMs).toBe(measurement.shots[index]!.endMs - measurement.shots[index]!.startMs);
    }
    // 切点在 2s 与 4s 附近（编码取整允许 ±180ms）。
    expect(Math.abs(measurement.shots[0]!.endMs - 2000)).toBeLessThan(180);
    expect(Math.abs(measurement.shots[1]!.endMs - 4000)).toBeLessThan(180);
    // 每镜中点主色对准该段纯色。
    expect(near(measurement.shots[0]!.palette[0]!, [255, 0, 0])).toBe(true);
    expect(near(measurement.shots[1]!.palette[0]!, [0, 0, 255])).toBe(true);
    expect(near(measurement.shots[2]!.palette[0]!, [0, 255, 0])).toBe(true);
    // 全局调色板覆盖三种颜色。
    expect(measurement.palette.length).toBeGreaterThanOrEqual(3);
    for (const expected of [[255, 0, 0], [0, 0, 255], [0, 255, 0]] as const)
      expect(measurement.palette.some(hex => near(hex, expected))).toBe(true);
    expect(measurement.captions).toBeUndefined();
    expect(measurement.limits.scope).toBe("cuts-and-palette");
    expect(medianShotMs(measurement)).toBeGreaterThan(1500);
  });

  it.skipIf(!available)("尊重参数校验与 min-shot-ms 合并", async () => {
    const dir = await root(), video = await synthetic(dir, ["red", "blue", "0x00ff00"], 1);
    await expect(analyzeReference(video, { threshold: 5 })).rejects.toThrow("threshold");
    await expect(analyzeReference(video, { minShotMs: 0 })).rejects.toThrow("minShotMs");
    await expect(analyzeReference("http://example.com/ref.mp4")).rejects.toThrow("本地文件路径");
    await expect(analyzeReference(path.join(dir, "missing.mp4"))).rejects.toThrow();
    // 段长 1s；min-shot-ms 2500 时三镜被并回单镜（无法再保尾段）。
    const merged = await analyzeReference(video, { minShotMs: 2500 });
    expect(merged.shots).toHaveLength(1);
    expect(merged.shots[0]!.startMs).toBe(0);
    expect(merged.shots[0]!.endMs).toBe(merged.durationMs);
    expect(merged.limits.mergedCuts).toBeGreaterThan(0);
  });

  it("量化器把纯色像素聚成主色且占比归一", () => {
    const rgb = new Uint8Array(4 * 3);
    for (let i = 0; i < 3; i++) { rgb[i * 3] = 250; rgb[i * 3 + 1] = 10; rgb[i * 3 + 2] = 10; }
    rgb[9] = 0; rgb[10] = 200; rgb[11] = 0;
    const palette = quantizeFramePalette(rgb);
    expect(palette[0]!.hex).toBe("#fa0a0a");
    expect(palette[0]!.share).toBeCloseTo(0.75, 5);
    expect(palette[1]!.hex).toBe("#00c800");
  });
});

const keepReplace = (measurement: { shots: { shot: number }[] }): KeepReplaceRow[] => measurement.shots.map(shot => ({
  shot: shot.shot,
  keep: shot.shot === 1 ? "暗场起手的悬念节奏与 2 秒镜长" : shot.shot === 2 ? "蓝底居中构图与缓慢推近" : "结尾三秒留读",
  replace: shot.shot === 1 ? "开场标题换成「春茶上新」" : shot.shot === 2 ? "蓝色底换成品牌米白与产品镜头" : "",
  evidenceMs: shot.shot === 2 ? 2500 : undefined,
}));

describe("buildRecreatePlan 骨架", () => {
  it.skipIf(!available)("镜头数与时长严格对齐测量值，Keep/Replace 进入占位说明", async () => {
    const dir = await root(), measurement = await analyzeReference(await synthetic(dir));
    const plan = buildRecreatePlan(measurement, keepReplace(measurement), { title: "春茶上新复刻" });
    expect(plan.format).toBe("glint-recreate-plan");
    expect(plan.title).toBe("春茶上新复刻");
    expect(plan.project.scenes).toHaveLength(measurement.shots.length);
    plan.project.scenes.forEach((scene, index) => {
      const shot = measurement.shots[index]!;
      expect(scene.id).toBe(`recreate-shot-${String(index + 1).padStart(3, "0")}`);
      expect(scene.narration.durationMs).toBe(shot.durationMs);
      expect(scene.narration.text).toContain(`${(shot.startMs / 1000).toFixed(1)}–${(shot.endMs / 1000).toFixed(1)} 秒`);
      expect(scene.narration.text).toContain("保留：");
    });
    expect(plan.project.scenes[0]!.narration.text).toContain("春茶上新");
    expect(plan.project.scenes[2]!.narration.text).toContain("只按你的品牌微调");
    expect(plan.project.aspect).toBe("16:9");
    expect(plan.project.theme).toMatchObject({ colors: { bg: measurement.palette[0] } });
    expect(plan.medianShotMs).toBe(medianShotMs(measurement));
    expect(plan.table).toHaveLength(3);
  });

  it.skipIf(!available)("表必须逐镜覆盖且字段合法", async () => {
    const dir = await root(), measurement = await analyzeReference(await synthetic(dir));
    expect(() => buildRecreatePlan({} as typeof measurement, [])).toThrow("glint-reference-measurement");
    expect(() => buildRecreatePlan(measurement, keepReplace(measurement).slice(1))).toThrow(/缺少镜头：1/);
    const duplicated = [...keepReplace(measurement), keepReplace(measurement)[0]!];
    expect(() => buildRecreatePlan(measurement, duplicated)).toThrow("重复镜头 1");
    const unknown = [...keepReplace(measurement)]; unknown[1] = { ...unknown[1]!, shot: 9 };
    expect(() => buildRecreatePlan(measurement, unknown)).toThrow(/越界/);
    const emptyKeep = keepReplace(measurement); emptyKeep[0] = { ...emptyKeep[0]!, keep: "  " };
    expect(() => buildRecreatePlan(measurement, emptyKeep)).toThrow("keep 必填");
  });
});

describe("评审表 recreateReviewTable", () => {
  it.skipIf(!available)("每镜给出证据帧号（中点缺省）并可渲染 Markdown", async () => {
    const dir = await root(), measurement = await analyzeReference(await synthetic(dir));
    const plan = buildRecreatePlan(measurement, keepReplace(measurement));
    const rows = recreateReviewTable(plan);
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      const shot = measurement.shots[index]!;
      if (index === 1) return; // 该行显式给了 evidenceMs，在下方单独断言。
      // 证据帧缺省取镜头中点换算帧号。
      const midpoint = Math.round((shot.startMs + shot.endMs) / 2);
      expect(row.evidenceFrame).toBe(Math.round(midpoint / 1000 * measurement.fps));
    });
    expect(rows[1]!.evidenceFrame).toBe(Math.round(2500 / 1000 * measurement.fps));
    const markdown = formatReviewTable(rows);
    expect(markdown.split("\n")[0]).toBe("| 镜 | 时间 | 证据帧 | 保留 | 替换 |");
    expect(markdown.split("\n")).toHaveLength(5);
    expect(markdown).toContain("春茶上新");
    expect(markdown).toContain("（无）");
  });

  it("拒绝非法计划", () => {
    expect(() => recreateReviewTable({ format: "other" } as never)).toThrow("glint-recreate-plan");
  });
});

describe("parseKeepReplaceTable", () => {
  it("解析 Markdown 表：镜头/保留/替换/证据帧（帧号按 fps 换算毫秒）", () => {
    const markdown = [
      "| 镜头 | 保留 | 替换 | 证据帧 |",
      "|---|---|---|---|",
      "| 1 | 2 秒镜长 | 换标题 | 20 |",
      "| 2 | 构图 | 换产品 | 50 |",
    ].join("\n");
    expect(parseKeepReplaceTable(markdown, 20)).toEqual([
      { shot: 1, keep: "2 秒镜长", replace: "换标题", evidenceMs: 1000 },
      { shot: 2, keep: "构图", replace: "换产品", evidenceMs: 2500 },
    ]);
    // 无 fps 时证据帧列不换算。
    expect(parseKeepReplaceTable(markdown)[0]).toEqual({ shot: 1, keep: "2 秒镜长", replace: "换标题" });
  });

  it("解析 JSON 数组并拒绝坏表头", () => {
    const rows: KeepReplaceRow[] = [{ shot: 1, keep: "节奏", replace: "文案" }];
    expect(parseKeepReplaceTable(JSON.stringify(rows))).toEqual(rows);
    expect(() => parseKeepReplaceTable("| 镜头 | 保留 |\n|---|---|\n| 1 | x |")).toThrow("「替换」");
    expect(() => parseKeepReplaceTable("随便一段文字")).toThrow("Markdown");
    expect(() => parseKeepReplaceTable("[]")).toThrow("不能为空");
  });
});

describe("CLI 参数解析（glint analyze-reference / recreate-plan 薄分发）", () => {
  it("缺参数给出用法", async () => {
    await expect(runAnalyzeReference([])).rejects.toThrow("analyze-reference requires --video=");
    await expect(runRecreatePlan(["--measurement=m.json"])).rejects.toThrow("recreate-plan requires --measurement=");
  });

  it.skipIf(!available)("analyze-reference 写测量 JSON；recreate-plan 吃测量+Markdown 表出骨架", async () => {
    const dir = await root(), video = await synthetic(dir);
    const measurementPath = path.join(dir, "measurement.json");
    await runAnalyzeReference([`--video=${video}`, `--out=${measurementPath}`, "--min-shot-ms=300"]);
    const measurement = JSON.parse(await fs.readFile(measurementPath, "utf8"));
    expect(measurement.format).toBe("glint-reference-measurement");
    expect(measurement.shots).toHaveLength(3);

    const tablePath = path.join(dir, "keep-replace.md");
    await fs.writeFile(tablePath, [
      "| 镜头 | 保留 | 替换 |",
      "|---|---|---|",
      "| 1 | 悬念节奏 | 换标题 |",
      "| 2 | 构图 | 换产品 |",
      "| 3 | 留读 | |",
    ].join("\n"));
    const planPath = path.join(dir, "plan.json");
    await runRecreatePlan([`--measurement=${measurementPath}`, `--table=${tablePath}`, `--out=${planPath}`, "--title=复刻验收"]);
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    expect(plan.format).toBe("glint-recreate-plan");
    expect(plan.project.scenes).toHaveLength(3);
    expect(plan.table).toHaveLength(3);

    await expect(runRecreatePlan([`--measurement=${measurementPath}`, `--table=${tablePath}`, `--out=${planPath}`])).rejects.toThrow("已存在");
    await expect(runRecreatePlan([`--measurement=${measurementPath}`, `--table=${path.join(dir, "missing.md")}`, `--out=${path.join(dir, "plan2.json")}`])).rejects.toThrow();
  });
});
