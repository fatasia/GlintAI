import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { parseProject } from "@glintai/scenescript";
import { expect, it } from "vitest";
import { createDirectCapture } from "./direct-browser";
import { findSystemBrowser } from "./direct-browser/host";

it.skipIf(process.env.GLINT_SHOWCASE_E2E !== "1")("shows the editable image framing in both preview and native export", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-showcase-")), publicDir = path.join(root, "public");
  fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(repo, "evidence/DRAMA-03/live-reference-20261027/media/191608366.png"), path.join(publicDir, "assets/product.png"));
  const base = { id: "product", kind: "image", src: "assets/product.png", caption: "一杯好咖啡", narration: { text: "产品展示", durationMs: 2000 } };
  const project = parseProject({ schemaVersion: 1, id: "showcase", title: "展示", aspect: "9:16", theme: "mint-clean", fps: 30, knowledgeSources: [], scenes: [{ ...base, presentation: "showcase", camera: { type: "push", intensity: 0.4 } }] });
  const staticProject = parseProject({ ...project, scenes: [base] });
  const panProject = parseProject({ ...project, scenes: [{ ...base, presentation: "showcase", camera: { type: "pan-left", intensity: 0.8 } }] });
  const panRightProject = parseProject({ ...project, scenes: [{ ...base, presentation: "showcase", camera: { type: "pan-right", intensity: 0.8 } }] });
  const pullProject = parseProject({ ...project, scenes: [{ ...base, presentation: "showcase", camera: { type: "pull", intensity: 0.8 } }] });
  let preview: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let direct: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const pixels = (file: string) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 2_000_000 });
    if (result.status !== 0) throw new Error("Cannot decode screenshot"); return result.stdout;
  };
  try {
    const serveUrl = await bundle({ entryPoint: path.join(repo, "apps/studio/src/index.ts"), publicDir });
    preview = await openBrowser("chrome", { browserExecutable: findSystemBrowser() });
    const renderPreview = async (value: typeof project, tag: string, plate = true) => {
      const inputProps = { project: value, plate };
      const composition = await selectComposition({ serveUrl, id: "Glint", inputProps, puppeteerInstance: preview });
      const result = await renderStill({ serveUrl, composition, inputProps, puppeteerInstance: preview, frame: 30, scale: 0.25, imageFormat: "png" });
      if (!result.buffer) throw new Error("No preview pixels"); fs.writeFileSync(path.join(root, `${tag}-preview.png`), result.buffer);
    };
    await renderPreview(staticProject, "standard"); await renderPreview(project, "showcase"); await renderPreview(panProject, "pan"); await renderPreview(panRightProject, "pan-right"); await renderPreview(pullProject, "pull");
    for (const [value, tag] of [[staticProject, "standard"], [project, "showcase"], [panProject, "pan"], [panRightProject, "pan-right"], [pullProject, "pull"]] as const) {
      direct = await createDirectCapture(value, publicDir, path.join(root, `capture-${tag}`), 270, 480);
      await direct.load(value.scenes[0]!, true);
      await direct.screenshot(0, path.join(root, `${tag}-early.png`));
      await direct.screenshot(30, path.join(root, `${tag}-direct.png`));
      if (tag !== "standard") expect(hash(path.join(root, `${tag}-early.png`))).not.toBe(hash(path.join(root, `${tag}-direct.png`)));
      const a = pixels(path.join(root, `${tag}-preview.png`)), b = pixels(path.join(root, `${tag}-direct.png`));
      expect(a.length).toBe(b.length);
      // Compare the central product, not global logo/progress/caption overlays.
      let difference = 0, samples = 0;
      for (let y = 110; y < 330; y += 3) for (let x = 45; x < 225; x += 3) for (let c = 0; c < 3; c++) { const i = (y * 270 + x) * 3 + c; difference += Math.abs(a[i]! - b[i]!); samples++; }
      expect(difference / samples).toBeLessThan(18);
      if (process.env.GLINT_SHOWCASE_EVIDENCE) for (const mode of ["preview", "direct"]) fs.copyFileSync(path.join(root, `${tag}-${mode}.png`), path.join(process.env.GLINT_SHOWCASE_EVIDENCE, `${tag}-${mode}.png`));
      await direct.close(); direct = undefined;
    }
    const duplicate = parseProject({ ...project, scenes: [{ ...base, presentation: "showcase", transition: { in: "fade", durationMs: 600 }, narration: { text: "一杯好咖啡", audioOffsetMs: 500, durationMs: 2000 } }] });
    const noLabel = parseProject({ ...duplicate, scenes: [{ ...duplicate.scenes[0], caption: undefined }] });
    const distinct = parseProject({ ...duplicate, scenes: [{ ...duplicate.scenes[0], caption: "优选咖啡" }] });
    const captionDiff = (left: string, right: string, top: number, bottom: number) => {
      const a = pixels(path.join(root, left)), b = pixels(path.join(root, right)); let difference = 0;
      for (let y = top; y < bottom; y++) for (let x = 20; x < 250; x++) for (let c = 0; c < 3; c++) { const i = (y * 270 + x) * 3 + c; difference += Math.abs(a[i]! - b[i]!); }
      return difference;
    };
    for (const [value, tag] of [[duplicate, "duplicate"], [noLabel, "no-label"], [distinct, "distinct"]] as const) {
      await renderPreview(value, tag);
      direct = await createDirectCapture(value, publicDir, path.join(root, `capture-${tag}`), 270, 480);
      await direct.load(value.scenes[0]!, true); await direct.screenshot(30, path.join(root, `${tag}-plate.png`));
      if (tag === "duplicate") {
        await direct.load(value.scenes[0]!, false);
        await direct.screenshot(5, path.join(root, "transition-before-subtitle.png"));
        await direct.screenshot(30, path.join(root, "duplicate-with-subtitle.png"));
        await direct.load(value.scenes[0]!, true); await direct.screenshot(5, path.join(root, "transition-clean-plate.png"));
      }
      await direct.close(); direct = undefined;
    }
    await renderPreview(duplicate, "duplicate-live", false);
    // At the same frame, an exact duplicate has the same hero label pixels as no label.
    for (const suffix of ["preview.png", "plate.png"]) {
      expect(captionDiff(`duplicate-${suffix}`, `no-label-${suffix}`, 360, 415)).toBeLessThan(10000);
      expect(captionDiff(`distinct-${suffix}`, `no-label-${suffix}`, 360, 415)).toBeGreaterThan(10000);
    }
    // A positive audio offset keeps the subtitle absent during entrance, then shows it independently.
    expect(captionDiff("transition-before-subtitle.png", "transition-clean-plate.png", 420, 465)).toBeLessThan(10000);
    expect(captionDiff("duplicate-with-subtitle.png", "duplicate-plate.png", 420, 465)).toBeGreaterThan(10000);
    expect(captionDiff("duplicate-live-preview.png", "duplicate-preview.png", 400, 475)).toBeGreaterThan(10000);
    const captionPixels = pixels(path.join(root, "duplicate-with-subtitle.png")), cleanPixels = pixels(path.join(root, "duplicate-plate.png"));
    let brightTextPixels = 0;
    for (let y = 420; y < 465; y++) for (let x = 20; x < 250; x++) {
      const i = (y * 270 + x) * 3;
      if (captionPixels[i]! > 210 && captionPixels[i + 1]! > 210 && captionPixels[i + 2]! > 210 && Math.abs(captionPixels[i]! - cleanPixels[i]!) > 40) brightTextPixels++;
    }
    expect(brightTextPixels).toBeGreaterThan(5);
    if (process.env.GLINT_SHOWCASE_EVIDENCE) for (const name of ["duplicate-preview.png", "duplicate-live-preview.png", "duplicate-plate.png", "duplicate-with-subtitle.png", "distinct-preview.png", "distinct-plate.png"]) fs.copyFileSync(path.join(root, name), path.join(process.env.GLINT_SHOWCASE_EVIDENCE, name));
  } finally { await direct?.close(); await preview?.close({ silent: true }); fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000);
