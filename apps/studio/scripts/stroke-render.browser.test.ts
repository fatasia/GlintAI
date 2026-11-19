import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Resvg } from "@resvg/resvg-js";
import { parseProject, type SceneElement } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { ElementOverlay } from "../../../packages/video/src/components/ElementOverlay";
import { expect, it } from "vitest";
import { renderElementLayer } from "./native-svg";
import { findSystemBrowser, openCaptureBrowser } from "./direct-browser/host";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no downloads */ }
it.skipIf(process.env.GLINT_STROKE_E2E !== "1" || !available)("matches editable draw-on curves in Chromium preview and native raster frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-stroke-render-"));
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const element: SceneElement = { id: "curve", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d: "M180 720 Q600 180 980 580 C1200 850 1430 260 1740 420", viewBox: [1920, 1080], stroke: "#dbc6a0", strokeWidth: 24, drawStartMs: 200, drawDurationMs: 1000 };
  const project = parseProject({ schemaVersion: 1, id: "stroke-render", title: "Stroke", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Stroke", narration: { text: "Stroke", durationMs: 2000 }, elements: [element] }] });
  const scene = project.scenes[0]!;
  try {
    opened = await openCaptureBrowser(480, 270); const page = opened.page;
    const counts: number[] = [];
    for (const timeMs of [0, 700, 1200]) {
      const markup = renderToStaticMarkup(createElement(ElementOverlay, { scene, timeMs, size: 0.25 }));
      await page.setContent(`<html><body style="margin:0;background:#101114"><div style="position:relative;width:480px;height:270px">${markup}</div></body></html>`);
      const preview = Buffer.from(await page.screenshot());
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#101114"/>${renderElementLayer(scene, 480, 270, 0.25, timeMs, resolveTheme(project.theme))}</svg>`;
      const native = new Resvg(svg).render().asPng();
      const stats = await page.evaluate(async (a, b) => {
        const decode = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 270; const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, 480, 270).data; };
        const left = await decode(a), right = await decode(b); let samples = 0, error = 0, pixels = 0;
        for (let i = 0; i < left.length; i += 4) {
          if (left[i]! > 40 || right[i]! > 40) { pixels++; for (let c = 0; c < 3; c++) { error += Math.abs(left[i + c]! - right[i + c]!); samples++; } }
        }
        return { pixels, meanError: samples ? error / samples : 0 };
      }, `data:image/png;base64,${preview.toString("base64")}`, `data:image/png;base64,${native.toString("base64")}`);
      counts.push(stats.pixels); expect(stats.meanError).toBeLessThan(12);
      if (process.env.GLINT_STROKE_EVIDENCE) {
        fs.mkdirSync(process.env.GLINT_STROKE_EVIDENCE, { recursive: true });
        fs.writeFileSync(path.join(process.env.GLINT_STROKE_EVIDENCE, `frame-${timeMs}-preview.png`), preview);
        fs.writeFileSync(path.join(process.env.GLINT_STROKE_EVIDENCE, `frame-${timeMs}-native.png`), native);
      }
    }
    expect(counts[0]).toBe(0); expect(counts[1]).toBeGreaterThan(100); expect(counts[2]).toBeGreaterThan(counts[1]! * 1.6);
  } finally {
    await opened?.browser.close();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.env.GLINT_STROKE_E2E !== "1" || !available)("matches draw-on arcs and relative commands in Chromium preview and native raster frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-stroke-arc-"));
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  // Relative H/V/S/T plus an elliptical arc: exercises the extended parser end to end.
  const element: SceneElement = { id: "arc", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, d: "M140 540 h180 a240 240 0 0 1 480 240 s-160 300 -320 240 T620 780 V300 h-200", viewBox: [1920, 1080], stroke: "#9ec3e6", strokeWidth: 24, drawStartMs: 200, drawDurationMs: 1000 };
  const project = parseProject({ schemaVersion: 1, id: "stroke-arc", title: "Stroke Arc", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Arc", narration: { text: "Arc", durationMs: 2000 }, elements: [element] }] });
  const scene = project.scenes[0]!;
  try {
    opened = await openCaptureBrowser(480, 270); const page = opened.page;
    const counts: number[] = [];
    for (const timeMs of [0, 700, 1200]) {
      const markup = renderToStaticMarkup(createElement(ElementOverlay, { scene, timeMs, size: 0.25 }));
      await page.setContent(`<html><body style="margin:0;background:#101114"><div style="position:relative;width:480px;height:270px">${markup}</div></body></html>`);
      const preview = Buffer.from(await page.screenshot());
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#101114"/>${renderElementLayer(scene, 480, 270, 0.25, timeMs, resolveTheme(project.theme))}</svg>`;
      const native = new Resvg(svg).render().asPng();
      const stats = await page.evaluate(async (a, b) => {
        const decode = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 270; const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, 480, 270).data; };
        const left = await decode(a), right = await decode(b); let samples = 0, error = 0, pixels = 0;
        for (let i = 0; i < left.length; i += 4) {
          if (left[i]! > 40 || right[i]! > 40) { pixels++; for (let c = 0; c < 3; c++) { error += Math.abs(left[i + c]! - right[i + c]!); samples++; } }
        }
        return { pixels, meanError: samples ? error / samples : 0 };
      }, `data:image/png;base64,${preview.toString("base64")}`, `data:image/png;base64,${native.toString("base64")}`);
      counts.push(stats.pixels); expect(stats.meanError).toBeLessThan(12);
      if (process.env.GLINT_STROKE_EVIDENCE) {
        fs.writeFileSync(path.join(process.env.GLINT_STROKE_EVIDENCE, `arc-${timeMs}-preview.png`), preview);
        fs.writeFileSync(path.join(process.env.GLINT_STROKE_EVIDENCE, `arc-${timeMs}-native.png`), native);
      }
    }
    expect(counts[0]).toBe(0); expect(counts[1]).toBeGreaterThan(100); expect(counts[2]).toBeGreaterThan(counts[1]! * 1.4);
  } finally {
    await opened?.browser.close();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
