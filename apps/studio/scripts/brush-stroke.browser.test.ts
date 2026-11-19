import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer from "puppeteer-core";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { ElementOverlay } from "../../../packages/video/src/components/ElementOverlay";
import { renderElementLayer } from "./native-svg";
import { findSystemBrowser } from "./direct-browser/host";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("matches actual preview and native SVG brush pixels at three seek times", async () => {
  const p = parseProject({ schemaVersion: 1, id: "brush-test", title: "P", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: " ", narration: { text: "x", durationMs: 2000 }, elements: [{ id: "paint", kind: "rect", appearance: "brush", x: .5, y: .5, w: .65, h: .25, fill: "#ce5129" }], tracks: [{ elementId: "paint", property: "x", keyframes: [{ atMs: 0, value: .3 }, { atMs: 1000, value: .7 }] }] }] });
  const scene = p.scenes[0]!, browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 320, height: 180, deviceScaleFactor: 1 });
    for (const time of [0, 500, 1000]) {
      const dom = renderToStaticMarkup(React.createElement(ElementOverlay, { scene, timeMs: time, size: 180 / 1080 }));
      const svg = `<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">${renderElementLayer(scene, 320, 180, 180 / 1080, time, resolveTheme())}</svg>`;
      await page.setContent(`<body style="margin:0;background:white">${dom}</body>`); const domShot = await page.screenshot({ encoding: "base64" });
      await page.setContent(`<body style="margin:0;background:white">${svg}</body>`); const svgShot = await page.screenshot({ encoding: "base64" });
      const difference = await page.evaluate(async shots => {
        const load = (shot: string) => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = `data:image/png;base64,${shot}`; });
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180; const ctx = canvas.getContext("2d")!;
        const [first, second] = await Promise.all(shots.map(load)); ctx.drawImage(first!, 0, 0); const x = ctx.getImageData(0, 0, 320, 180).data; ctx.clearRect(0, 0, 320, 180); ctx.drawImage(second!, 0, 0); const y = ctx.getImageData(0, 0, 320, 180).data;
        let changed = 0; for (let i = 0; i < x.length; i += 4) if (Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!)) > 8) changed++;
        return changed;
      }, [domShot, svgShot]);
      expect(difference).toBeLessThan(200);
    }
  } finally { await browser.close(); }
}, 60000);
