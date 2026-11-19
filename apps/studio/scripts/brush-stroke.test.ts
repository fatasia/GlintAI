import { createHash } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Resvg } from "@resvg/resvg-js";
import { expect, it } from "vitest";
import { parseProject, BRUSH_PATHS } from "@glintai/scenescript";
import { ElementOverlay } from "../../../packages/video/src/components/ElementOverlay";
import { setRectAppearance, setRectProperty, upsertKeyframe } from "../../web/src/shot-model";
import { renderSceneSvg } from "./native-svg";

const input = () => ({ schemaVersion: 1, id: "brush", title: "Brush", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: " ", narration: { text: "笔触", durationMs: 2000 }, elements: [{ id: "paint", kind: "rect", x: .5, y: .5, w: .6, h: .3, fill: "#d24d2f" }] }] });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("edits a fixed brush vector, keeps old rectangles solid, and renders animated pixels", () => {
  const p = parseProject(input()), original = p.scenes[0]!;
  expect(original.elements?.[0]).not.toHaveProperty("appearance");
  let edited = setRectAppearance(original, "paint", "brush");
  edited = setRectProperty(edited, "paint", "w", .8);
  edited = setRectProperty(edited, "paint", "fill", "#2678a2");
  edited = upsertKeyframe(edited, "paint", "x", 0, .3);
  edited = upsertKeyframe(edited, "paint", "x", 1000, .7);
  const parsed = parseProject({ ...p, scenes: [edited] });
  expect(parsed.scenes[0]!.elements?.[0]).toMatchObject({ appearance: "brush", w: .8, fill: "#2678a2" });
  const frame = (scene: typeof edited, n: number) => new Resvg(renderSceneSvg(p, scene, n, { width: 320, height: 180 }), { font: { loadSystemFonts: false } }).render().asPng();
  expect(hash(frame(original, 15))).not.toBe(hash(frame(edited, 15)));
  expect(hash(frame(edited, 0))).not.toBe(hash(frame(edited, 30)));
  expect(hash(frame(edited, 15))).toBe(hash(frame(edited, 15)));
  const markup = renderToStaticMarkup(React.createElement(ElementOverlay, { scene: edited, timeMs: 500 }));
  const svg = renderSceneSvg(p, edited, 15, { width: 320, height: 180 });
  for (const path of BRUSH_PATHS) { expect(markup).toContain(path.d); expect(svg).toContain(path.d); }
});

it("refuses unsupported scenes and shape morphs with mismatched visual forms", () => {
  const p = parseProject(input());
  const paint = p.scenes[0]!.elements![0]!;
  const brush = { ...paint, appearance: "brush" };
  expect(() => parseProject({ ...p, scenes: [{ id: "photo", kind: "image", src: "assets/a.png", narration: { text: "x" }, elements: [brush] }] })).toThrow(/brush appearance requires/);
  expect(() => parseProject({ ...p, scenes: [p.scenes[0], { ...p.scenes[0], id: "two", transition: { in: "shape-morph" }, elements: [brush] }] })).toThrow(/same appearance/);
  expect(() => parseProject({ ...p, scenes: [{ ...p.scenes[0], elements: [brush] }, { ...p.scenes[0], id: "two", transition: { in: "shape-morph" }, elements: [brush] }] })).not.toThrow();
});
