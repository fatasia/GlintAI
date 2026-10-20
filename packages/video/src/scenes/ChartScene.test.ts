import { expect, it } from "vitest";
import { chartDomain } from "./ChartScene";
import { ChartScene } from "@glintai/scenescript";
it("keeps zero in positive/negative chart domains and avoids division by zero", () => {
  expect(chartDomain([{ value: 0 }])).toEqual({ min: 0, max: 1 });
  expect(chartDomain([{ value: -4 }, { value: 8 }])).toEqual({ min: -4, max: 8 });
});
it("requires finite, bounded chart data", () => {
  const scene = { id: "chart", kind: "chart", chartType: "bar", narration: { text: "Data" }, data: [{ label: "A", value: 18 }] };
  expect(ChartScene.parse(scene).data[0]!.value).toBe(18);
  for (const data of [[], [{ label: "A", value: Infinity }], Array.from({ length: 25 }, () => ({ label: "A", value: 1 }))]) expect(() => ChartScene.parse({ ...scene, data })).toThrow();
});
