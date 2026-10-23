import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Page } from "puppeteer-core";
import type { Scene, SceneScriptProject } from "@glintai/scenescript";
import { copyProjectAssets } from "../assets";
import { copyRuntimeDecoders, ensureDecoders, resolveRuntimeDecoder } from "../decoders";
import { startAssetServer, openCaptureBrowser } from "./host";

export async function createDirectCapture(project: SceneScriptProject, projectDir: string, root: string, width: number, height: number, signal?: AbortSignal) {
  fs.mkdirSync(root, { recursive: true });
  const prepared = await copyProjectAssets(projectDir, root, project);
  await copyRuntimeDecoders(root);
  if (project.scenes.some(s => s.kind === "three" && s.model === "gltf")) await ensureDecoders(root);
  const threeRoot = path.resolve(path.dirname(resolveRuntimeDecoder("three")), "..");
  const bundle = await build({ entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "page.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2020", alias: { three: threeRoot }, minify: true, metafile: true });
  if (Object.keys(bundle.metafile!.inputs).some(file => /node_modules[\\/].*remotion[\\/]/.test(file))) throw new Error("Independent backend unexpectedly bundled Remotion");
  fs.writeFileSync(path.join(root, "page.js"), bundle.outputFiles[0]!.contents);
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/page.js"></script></body></html>');
  const server = await startAssetServer(root);
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>>["browser"] | undefined;
  let page: Page;
  try {
    const opened = await openCaptureBrowser(width, height); browser = opened.browser; page = opened.page;
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith(server.url + "/") || url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank" || url === "about:srcdoc") void request.continue();
      else void request.abort("blockedbyclient");
    });
    await page.goto(server.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction("window.__glintReady === true", { timeout: 30000 });
  } catch (error) { await browser?.close(); await server.close(); throw error; }
  const abort = () => { void browser?.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    async load(scene: Scene, plate = false) {
      signal?.throwIfAborted();
      const actual = prepared.scenes.find(s => s.id === scene.id)!;
      await page.evaluate(async (p, s, clean) => { await (window as any).__glintInit(p, s, clean); }, prepared, actual, plate);
    },
    async screenshot(frame: number, output: string) {
      signal?.throwIfAborted();
      await page.evaluate(async f => { await (window as any).__glintSeek(f); }, frame);
      await page.screenshot({ path: output as `${string}.png`, type: "png" });
    },
    async close() { signal?.removeEventListener("abort", abort); await browser?.close(); await server.close(); },
  };
}
