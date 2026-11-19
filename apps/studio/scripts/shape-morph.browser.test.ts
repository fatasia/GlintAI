import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer from "puppeteer-core";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { ElementOverlay } from "../../../packages/video/src/components/ElementOverlay";
import { renderElementLayer } from "./native-svg";
import { findSystemBrowser } from "./direct-browser/host";
import { createDirectCapture } from "./direct-browser";
import { createHash } from "node:crypto";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no download */ }
const project = () => parseProject({ schemaVersion: 1, id: "morph-test", title: "P", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: " ", narration: { text: "a", durationMs: 1400 }, elements: [{ id: "card", kind: "rect", x: .25, y: .35, w: .2, h: .3, fill: "#ff0000", radius: 12 }] },
  { id: "two", kind: "title", title: " ", narration: { text: "b", durationMs: 2600 }, transition: { in: "shape-morph", durationMs: 1000 }, elements: [{ id: "card", kind: "rect", x: .7, y: .65, w: .5, h: .15, fill: "#0000ff", radius: 48 }] },
] });

const pathProject = () => {
  const p = project();
  const line = { id: "line", kind: "path" as const, x: .5, y: .5, w: .6, h: .6, d: "M10 10 L90 10 Q90 90 10 90 Z", viewBox: [100, 100] as [number, number], stroke: "#ff0000", strokeWidth: 4 };
  p.scenes[0]!.elements = [line];
  p.scenes[1]!.elements = [{ ...line, d: "M20 20 L80 20 Q80 80 20 80 Z", stroke: "#0000ff", strokeWidth: 8 }];
  return parseProject(p);
};

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("compares actual preview DOM and native SVG pixels and direct-capture seek order", async () => {
  const p = project(), [a, b] = p.scenes, root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-morph-"));
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true, args: ["--no-sandbox"] });
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 320, height: 180, deviceScaleFactor: 1 });
    const theme = resolveTheme(p.theme);
    for (const current of [p, pathProject()]) for (const time of [0, 500, 1000]) {
      const [source, target] = current.scenes;
      const dom = renderToStaticMarkup(React.createElement(ElementOverlay, { scene: target!, previousScene: source, timeMs: time, size: 180 / 1080 }));
      const svg = `<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">${renderElementLayer(target!, 320, 180, 180 / 1080, time, theme, source)}</svg>`;
      await page.setContent(`<body style="margin:0;background:white">${dom}</body>`); const domShot = await page.screenshot({ encoding: "base64" });
      await page.setContent(`<body style="margin:0;background:white">${svg}</body>`); const svgShot = await page.screenshot({ encoding: "base64" });
      const result = await page.evaluate(async (shots) => {
        const load = (shot: string) => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = `data:image/png;base64,${shot}`; });
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180; const ctx = canvas.getContext("2d")!;
        const [first, second] = await Promise.all(shots.map(load)); ctx.drawImage(first!, 0, 0); const x = ctx.getImageData(0, 0, 320, 180).data; ctx.clearRect(0, 0, 320, 180); ctx.drawImage(second!, 0, 0); const y = ctx.getImageData(0, 0, 320, 180).data;
        let changed = 0; for (let i = 0; i < x.length; i += 4) if (Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!)) > 8) changed++;
        return changed;
      }, [domShot, svgShot]);
      expect(result).toBeLessThan(200); // only edge antialiasing may differ
    }
    capture = await createDirectCapture(p, root, path.join(root, "public"), 320, 180);
    await capture.load(b!); const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    await capture.screenshot(15, path.join(root, "mid.png")); await capture.screenshot(0, path.join(root, "start.png")); await capture.screenshot(30, path.join(root, "end.png")); await capture.screenshot(15, path.join(root, "repeat.png"));
    expect(hash(path.join(root, "mid.png"))).toBe(hash(path.join(root, "repeat.png")));
    expect(hash(path.join(root, "start.png"))).not.toBe(hash(path.join(root, "mid.png")));
    expect(hash(path.join(root, "end.png"))).not.toBe(hash(path.join(root, "mid.png")));
    if (process.env.GLINT_SHAPE_MORPH_EVIDENCE) for (const file of ["start.png", "mid.png", "end.png"]) fs.copyFileSync(path.join(root, file), path.join(process.env.GLINT_SHAPE_MORPH_EVIDENCE, file));
  } finally { await capture?.close(); await browser.close(); if (!process.env.GLINT_PRESERVE_TEST_DATA) fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
