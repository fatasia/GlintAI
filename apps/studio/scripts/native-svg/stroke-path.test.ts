import { expect, it } from "vitest";
import { parseProject, strokePathAt, strokeProgress } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { renderElementLayer } from "./index";

it("renders exactly the shared frame-driven path and keeps geometry aspect ratio", () => {
  const project = parseProject({ schemaVersion: 1, id: "stroke-render", title: "Stroke", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Stroke", narration: { text: "Stroke", durationMs: 2000 }, elements: [{ id: "stroke", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d: "M100 100 Q500 800 1000 100", viewBox: [1920, 1080], stroke: "#dbc6a0", strokeWidth: 8, drawStartMs: 200, drawDurationMs: 1000 }] }] });
  const scene = project.scenes[0]!, element = scene.elements![0]!;
  if (element.kind !== "path") throw new Error("fixture");
  const render = (timeMs: number) => renderElementLayer(scene, 960, 540, 0.5, timeMs, resolveTheme(project.theme));
  expect(render(0)).toContain('d=""');
  const half = strokePathAt(element.d, strokeProgress(element, 700));
  expect(render(700)).toContain(`d="${half}"`);
  expect(render(1200)).toContain(`d="${element.d}"`);
  expect(render(700)).toContain('viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet"');
  expect(render(700)).toContain('stroke-linecap="round"');
  for (const time of [NaN, Infinity, -Infinity]) expect(() => render(time)).toThrow(/time.*finite/i);
  expect(render(700)).toContain(`d="${half}"`);
});
