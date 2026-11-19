import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChartScene } from "@glintai/scenescript";
import { chartScenesFromTable } from "@glintai/composer";
import { ChartSceneView, chartDomain } from "../../../packages/video/src/scenes/ChartScene";

// MOTION-06: the data-driven update chain is table → chartScenesFromTable →
// ChartScene → markup. Frames are a pure function of (data, frame): the same
// data must render identically, an updated table must move the geometry, and
// nothing may keep state between renders.
const state = vi.hoisted(() => ({ frame: 30 }));
vi.mock("remotion", () => ({
  interpolate: (input: number, inRange: number[], outRange: number[], options?: { extrapolateLeft?: string; extrapolateRight?: string }) => {
    const [inMin, inMax] = inRange, [outMin, outMax] = outRange;
    if (inMin === undefined || inMax === undefined || outMin === undefined || outMax === undefined) throw new Error("interpolate ranges need two points");
    let progress = inMax === inMin ? 0 : (input - inMin) / (inMax - inMin);
    if (options?.extrapolateLeft === "clamp" && progress < 0) progress = 0;
    if (options?.extrapolateRight === "clamp" && progress > 1) progress = 1;
    return outMin + progress * (outMax - outMin);
  },
  useCurrentFrame: () => state.frame,
  useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080 }),
}));

const markup = (scene: ChartScene, frame: number) => {
  state.frame = frame;
  return renderToStaticMarkup(createElement(ChartSceneView, { scene }));
};
const rects = (svg: string) => [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g)]
  .map((match) => ({ x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) }));
const bar = (values: number[], chartType: "bar" | "line" = "bar"): ChartScene => ({
  id: "chart", kind: "chart", chartType, narration: { text: "数据" },
  data: values.map((value, index) => ({ label: `第${index + 1}项`, value })),
});

describe("table → chart scene chain", () => {
  it("picks the chart shape from the table and keeps scenes editable", () => {
    const single = chartScenesFromTable("月份,销量\n1月,12\n2月,30\n3月,8");
    expect(single.scenes).toHaveLength(1);
    expect(single.scenes[0]).toMatchObject({ kind: "chart", chartType: "bar", data: [{ label: "1月", value: 12 }, { label: "2月", value: 30 }, { label: "3月", value: 8 }] });
    const combo = chartScenesFromTable("月份,销量,利润\n1月,12,3\n2月,30,9");
    expect(combo.scenes[0]).toMatchObject({ chartType: "combo", seriesLabel2: "利润" });
    const dated = chartScenesFromTable("日期,温度\n2024-3-1,9\n2024-1-2,4\n2024-2-1,6");
    expect((dated.scenes[0] as ChartScene).data.map((point) => point.label)).toEqual(["2024-1-2", "2024-2-1", "2024-3-1"]);
    expect(dated.warnings.some((warning) => warning.includes("日期"))).toBe(true);
    expect(() => chartScenesFromTable("a,b\nx,\n")).toThrow(/数值列/);
  });
});

describe("data → geometry contract", () => {
  it("maps values monotonically onto bar heights", () => {
    const scene = bar([10, 50, 100]) as ChartScene;
    const bars = rects(markup(scene, 60));
    expect(bars).toHaveLength(3);
    expect(bars[1]!.h).toBeGreaterThan(bars[0]!.h);
    expect(bars[2]!.h).toBeGreaterThan(bars[1]!.h);
    // Halfway value renders half the tallest bar's height.
    expect(bars[1]!.h / bars[2]!.h).toBeCloseTo(0.5, 5);
    expect(chartDomain([{ value: 0 }])).toEqual({ min: 0, max: 1 });
  });
  it("updates geometry when the table changes and stays deterministic otherwise", () => {
    const before = bar([20, 80]) as ChartScene;
    const after = { ...before, data: [{ label: "第1项", value: 70 }, { label: "第2项", value: 30 }] };
    const beforeA = rects(markup(before, 60)), beforeB = rects(markup(before, 60));
    expect(beforeA).toEqual(beforeB);
    const afterBars = rects(markup(after, 60));
    expect(afterBars[0]!.h).toBeGreaterThan(beforeA[0]!.h);
    expect(afterBars[1]!.h).toBeLessThan(beforeA[1]!.h);
    expect(markup(after, 60)).toBe(markup(after, 60));
  });
  it("pages long series without mutating the scene data", () => {
    const values = Array.from({ length: 13 }, (_, index) => index + 1);
    const scene = { ...bar(values), narration: { text: "数据", durationMs: 6000 } } as ChartScene;
    const first = markup(scene, 30), second = markup(scene, 90);
    expect(first).toContain("1–6");
    expect(second).toContain("7–12");
    expect(markup(scene, 150)).toContain("13–13");
    expect(scene.data).toHaveLength(13);
  });
  it("draws negative values below the zero axis", () => {
    const scene = bar([-40, 60]) as ChartScene;
    const { min, max } = chartDomain(scene.data);
    expect(min).toBe(-40);
    const bars = rects(markup(scene, 60));
    expect(bars).toHaveLength(2);
    expect(bars[0]!.y).toBeGreaterThan(bars[1]!.y);
  });
});
