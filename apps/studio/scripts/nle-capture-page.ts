import { installMotionCapture, type MotionCaptureHost } from "./nle-motion-capture";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { renderNleFrame, syncNleMedia, type NleFrameHost } from "@glintai/video/nle-dom";

/**
 * In-page harness for deterministic NLE frame capture. The CLI bundles this
 * file, serves it over the asset server and drives it frame by frame; the
 * preview component renders through the same nle-dom contract.
 */
const state = window as unknown as {
  __glintNleInit(project: unknown, assetBase: string, viewScale: number, transparent: boolean): Promise<void>;
  __glintNleSeek(tMs: number): Promise<void>;
};

let host: NleFrameHost | undefined;
let project: NleProject | undefined;
let transparent = false;

/**
 * Headless Chrome rasterises the very first CJK glyph on a page with a broken
 * fallback cache (tofu), while every later text node is fine. Warm the fallback
 * with representative glyphs on a painted node before the first real frame.
 */
async function warmFontFallback(): Promise<void> {
  const warm = document.createElement("div");
  warm.textContent = "Glint 引擎验收 Aa 0123";
  warm.style.cssText = "position:absolute;top:0;left:0;font:16px sans-serif;color:transparent;pointer-events:none;";
  document.body.append(warm);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  warm.remove();
  await document.fonts?.ready.catch(() => {});
}

state.__glintNleInit = async (raw, assetBase, viewScale, alpha) => {
  await warmFontFallback();
  transparent = alpha === true;
  project = parseNleProject(raw);
  const root = document.getElementById("root")!;
  root.style.cssText = `position:absolute;top:0;left:0;transform-origin:top left;transform:scale(${viewScale});`;
  document.body.style.cssText = `margin:0;overflow:hidden;background:${transparent ? "transparent" : "#000"};`;
  host = { root, resolveAsset: src => `${assetBase}${src.slice("assets/".length)}` };
  renderNleFrame(host, project, 0, { playing: false, transparentBackground: transparent });
};

state.__glintNleSeek = async tMs => {
  if (!host || !project) throw new Error("NLE harness not initialised");
  renderNleFrame(host, project, tMs, { playing: false, transparentBackground: transparent });
  await syncNleMedia(host);
  // A headless compositor presents on demand, so a frame whose element already
  // sits at the target (syncNleMedia's skip path) may never have been painted.
  // Wobble every video by +0.1ms — same frame at any project fps — to force a
  // fresh present, then wait out those seeks before the screenshot.
  const videos = [...document.querySelectorAll("video")];
  for (const video of videos) video.currentTime += 0.0001;
  await Promise.all(videos.map(video => new Promise<void>(resolve => {
    video.addEventListener("seeked", () => resolve(), { once: true });
  })));
  // Let styles/layout settle before the screenshot.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};

installMotionCapture(window as unknown as MotionCaptureHost);
