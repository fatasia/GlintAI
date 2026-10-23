import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { effectFilterSvg, parseProject, wrapSvgEffects, type SceneEffect } from "@glintai/scenescript";
import { openCaptureBrowser, findSystemBrowser } from "./direct-browser/host";
import { createDirectCapture } from "./direct-browser";
import { renderSceneSvg } from "./native-svg";

let available = false;
try { findSystemBrowser(); available = true; } catch { /* Explicitly browser-gated. No download or network fallback. */ }
const fixtureSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#5273a4"/><rect width="32" height="64" fill="#d06020"/><rect x="64" width="32" height="64" fill="#63c688"/></svg>';
const decode = (png: Uint8Array, width: number, height: number) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`).render().pixels;
const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];

it("native scene filters apply pixels and identity/disabled stacks preserve bytes", () => {
  const project = parseProject({ schemaVersion: 1, id: "effects-pixels", title: "FX", aspect: "16:9", knowledgeSources: [], scenes: [{
    id: "one", kind: "title", title: "Color", narration: { text: "test", durationMs: 1000 },
    elements: [{ id: "color", kind: "rect", x: 0.5, y: 0.5, w: 1, h: 1, fill: "#ff0000" }],
  }] });
  // Title is required: keep it outside the center pixel rather than invalidating input.
  project.scenes[0] = { ...project.scenes[0]!, kind: "title", title: "Color" };
  const scene = project.scenes[0]!;
  const plain = renderSceneSvg(project, scene, 0, { width: 192, height: 108 });
  const filtered = renderSceneSvg(project, { ...scene, effects: [{ id: "mono", kind: "grayscale", value: 1 }] }, 0, { width: 192, height: 108 });
  const color = pixel(new Resvg(plain).render().pixels, 192, 96, 54);
  const mono = pixel(new Resvg(filtered).render().pixels, 192, 96, 54);
  expect(color[0]).toBeGreaterThan(200); expect(color[1]).toBeLessThan(5);
  expect(Math.max(...mono) - Math.min(...mono)).toBeLessThanOrEqual(1);
  expect(renderSceneSvg(project, { ...scene, effects: [{ id: "identity", kind: "brightness", value: 1 }] }, 0, { width: 192, height: 108 })).toBe(plain);
  expect(renderSceneSvg(project, { ...scene, effects: [{ id: "off", kind: "grayscale", value: 1, enabled: false }] }, 0, { width: 192, height: 108 })).toBe(plain);
});

describe.skipIf(!available)("shared SVG effect pixels in system Chrome", () => {
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>>;
  beforeAll(async () => { opened = await openCaptureBrowser(96, 64); }, 60_000);
  afterAll(async () => { await opened?.browser.close(); });
  const screenshot = async (markup: string) => {
    await opened.page.setContent(`<html><body style="margin:0;overflow:hidden">${markup}</body></html>`);
    await opened.page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    return decode(await opened.page.screenshot({ type: "png" }), 96, 64);
  };
  it.each([
    ["brightness", 0.65], ["contrast", 1.3], ["saturate", 0.4], ["grayscale", 1], ["sepia", 0.7], ["hue", 60], ["blur", 2],
  ] as const)("matches native %s primitives within raster tolerance", async (kind, value) => {
    const effects: SceneEffect[] = [{ id: "effect", kind, value }];
    const svg = wrapSvgEffects(fixtureSvg, effects, 0);
    const native = new Resvg(svg).render().pixels;
    const browser = await screenshot(svg);
    for (const x of [12, 48, 84]) {
      const a = pixel(native, 96, x, 32), b = pixel(browser, 96, x, 32);
      expect(Math.max(...a.map((channel, index) => Math.abs(channel - b[index]!)))).toBeLessThanOrEqual(4);
    }
  });
  it("applies browser HTML preview filters in the same order and time as native SVG", async () => {
    const effects: SceneEffect[] = [
      { id: "bright", kind: "brightness", value: 0.5, keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 1 }] },
      { id: "contrast", kind: "contrast", value: 1.5 },
    ];
    const filter = effectFilterSvg(effects, 500, "html-preview");
    const browser = await screenshot(`<svg width="0" height="0" style="position:absolute">${filter.defs}</svg><div style="width:96px;height:64px;filter:${filter.filter}"><div style="width:96px;height:64px;background:#5273a4"><div style="position:absolute;width:32px;height:64px;background:#d06020"></div><div style="position:absolute;left:64px;width:32px;height:64px;background:#63c688"></div></div></div>`);
    const native = new Resvg(wrapSvgEffects(fixtureSvg, effects, 500)).render().pixels;
    const reversed = new Resvg(wrapSvgEffects(fixtureSvg, [...effects].reverse(), 500)).render().pixels;
    const a = pixel(native, 96, 48, 32), b = pixel(browser, 96, 48, 32), c = pixel(reversed, 96, 48, 32);
    expect(Math.max(...a.map((channel, index) => Math.abs(channel - b[index]!)))).toBeLessThanOrEqual(4);
    expect(a).not.toEqual(c);
  });
  it("matches native primitives, order, time and disabled effects through actual sandboxed HTML capture", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-html-fx-"));
    let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
    const cases: { id: string; effects: SceneEffect[] }[] = [
      ...([ ["brightness", 0.65], ["contrast", 1.3], ["saturate", 0.4], ["grayscale", 1], ["sepia", 0.7], ["hue", 60], ["blur", 2] ] as const)
        .map(([kind, value]) => ({ id: kind, effects: [{ id: kind, kind, value }] })),
      { id: "animated", effects: [
        { id: "bright", kind: "brightness", value: 0.5, keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 1 }] },
        { id: "contrast", kind: "contrast", value: 1.5 },
      ] },
      { id: "disabled", effects: [{ id: "off", kind: "grayscale", value: 1, enabled: false }] },
      { id: "identity", effects: [{ id: "identity", kind: "brightness", value: 1 }] },
      { id: "window", effects: [{ id: "window", kind: "grayscale", value: 1, startMs: 250, endMs: 750 }] },
    ];
    try {
      const project = parseProject({ schemaVersion: 1, id: "html-fx", title: "FX", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: cases.map(test => ({
        ...test, kind: "html", html: '<div style="position:absolute;inset:0;background:#5273a4"><div style="position:absolute;inset:0 auto 0 0;width:33.333333%;background:#d06020"></div><div style="position:absolute;inset:0 0 0 auto;width:33.333333%;background:#63c688"></div></div>',
        narration: { text: "test", durationMs: 2000 },
      })) });
      capture = await createDirectCapture(project, root, path.join(root, "public"), 96, 64);
      for (const scene of project.scenes) {
        await capture.load(scene, true);
        // Repeated/out-of-order seeks must update both SVG defs and active windows.
        for (const frame of [15, 30, 0, 15]) {
          const file = path.join(root, "frame.png"); await capture.screenshot(frame, file);
          const browser = decode(fs.readFileSync(file), 96, 64);
          const native = new Resvg(wrapSvgEffects(fixtureSvg, scene.effects, frame / 30 * 1000)).render().pixels;
          for (const x of [12, 31, 32, 48, 63, 64, 84]) {
            const actual = pixel(browser, 96, x, 32), expected = pixel(native, 96, x, 32);
            expect(Math.max(...actual.map((channel, index) => Math.abs(channel - expected[index]!))), `${scene.id} frame ${frame} x ${x}`).toBeLessThanOrEqual(4);
          }
        }
      }
    } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
  it("filters actual image and video capture without leaking effects between loads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-fx-"));
    let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
    try {
      fs.mkdirSync(path.join(root, "assets"));
      fs.writeFileSync(path.join(root, "assets", "red.png"), new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="108"><rect width="192" height="108" fill="red"/></svg>').render().asPng());
      const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
      if (hasFfmpeg) {
        const generated = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=192x108:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "assets", "red.mp4")], { stdio: "inherit" });
        expect(generated.status).toBe(0);
      }
      const project = parseProject({ schemaVersion: 1, id: "media-fx", title: "FX", aspect: "16:9", knowledgeSources: [], scenes: [
        ...(["image", ...(hasFfmpeg ? ["video"] : [])] as const).flatMap(kind => [false, true, false].map((enabled, index) => ({
          id: `${kind}-${index}`, kind, src: `assets/red.${kind === "image" ? "png" : "mp4"}`,
          narration: { text: "test", durationMs: 1000 }, effects: [{ id: "mono", kind: "grayscale", value: 1, enabled }],
        }))),
      ] });
      capture = await createDirectCapture(project, root, path.join(root, "public"), 192, 108);
      const baselines = new Map<string, number[]>();
      for (const scene of project.scenes) {
        await capture.load(scene, true);
        const file = path.join(root, "frame.png"); await capture.screenshot(15, file);
        const rgb = pixel(decode(fs.readFileSync(file), 192, 108), 192, 96, 54);
        const baseline = baselines.get(scene.kind);
        if (scene.effects![0]!.enabled) {
          expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(1);
          // Compare against this browser's decoded source, including its video
          // color conversion, rather than assuming encoded YUV red is RGB red.
          const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="108"><rect width="192" height="108" fill="rgb(${baseline!.join(",")})"/></svg>`;
          const expected = pixel(new Resvg(wrapSvgEffects(sourceSvg, scene.effects, 500)).render().pixels, 192, 96, 54);
          expect(Math.max(...rgb.map((channel, index) => Math.abs(channel - expected[index]!)))).toBeLessThanOrEqual(4);
        } else if (baseline) {
          expect(rgb).toEqual(baseline);
        } else {
          expect(rgb[0]).toBeGreaterThan(200); expect(rgb[0]! - Math.max(rgb[1]!, rgb[2]!)).toBeGreaterThan(180);
          baselines.set(scene.kind, rgb);
        }
      }
    } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
  it("wires effects into actual direct-browser scene capture, not only the helper", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-direct-fx-"));
    let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
    try {
      const project = parseProject({ schemaVersion: 1, id: "direct-fx", title: "FX", aspect: "16:9", knowledgeSources: [], scenes: [{
        id: "one", kind: "html", html: '<html><body style="margin:0;background:rgb(255,0,0)"></body></html>',
        narration: { text: "test", durationMs: 1000 }, effects: [{ id: "mono", kind: "grayscale", value: 1 }],
      }] });
      capture = await createDirectCapture(project, root, path.join(root, "public"), 192, 108);
      await capture.load(project.scenes[0]!, true);
      const file = path.join(root, "frame.png"); await capture.screenshot(0, file);
      const rgb = pixel(decode(fs.readFileSync(file), 192, 108), 192, 96, 54);
      expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(1);
      expect(rgb[0]).toBeGreaterThan(20);
    } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
});
