import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { parseProject } from "@glintai/scenescript";
import { expect, it } from "vitest";
import { setElementAnimated, setRectProperty, upsertKeyframe } from "../../web/src/shot-model";
import { renderSceneSvg } from "./native-svg";

it("renders shape edits and keyframes into actual native SVG pixels", () => {
  const project = parseProject({ schemaVersion: 1, id: "shape", title: "Shape", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: " ", narration: { text: "形状", durationMs: 2000 }, elements: [{ id: "box", kind: "rect", x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: "#ff0000" }] }] });
  const original = project.scenes[0]!;
  let changed = setRectProperty(original, "box", "w", 0.6);
  changed = setRectProperty(changed, "box", "fill", "#00ff00");
  changed = setElementAnimated(changed, "box", "rotate", 0, 0);
  changed = upsertKeyframe(changed, "box", "rotate", 1000, 90);
  const pixels = (scene: typeof changed, frame: number) => new Resvg(renderSceneSvg(project, scene, frame, { width: 320, height: 180, plate: false }), { font: { loadSystemFonts: false } }).render().asPng();
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(hash(pixels(original, 15))).not.toBe(hash(pixels(changed, 15)));
  const midpoint = pixels(changed, 15); expect(hash(midpoint)).not.toBe(hash(pixels(changed, 30)));
  expect(hash(midpoint)).toBe(hash(pixels(changed, 15)));
});
