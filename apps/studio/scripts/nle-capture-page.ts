import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { renderNleFrame, syncNleMedia, type NleFrameHost } from "@glintai/video/nle-dom";

/**
 * In-page harness for deterministic NLE frame capture. The CLI bundles this
 * file, serves it over the asset server and drives it frame by frame; the
 * preview component renders through the same nle-dom contract.
 */
const state = window as unknown as {
  __glintNleInit(project: unknown, assetBase: string, viewScale: number): Promise<void>;
  __glintNleSeek(tMs: number): Promise<void>;
};

let host: NleFrameHost | undefined;
let project: NleProject | undefined;

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

state.__glintNleInit = async (raw, assetBase, viewScale) => {
  await warmFontFallback();
  project = parseNleProject(raw);
  const root = document.getElementById("root")!;
  root.style.cssText = `position:absolute;top:0;left:0;transform-origin:top left;transform:scale(${viewScale});`;
  document.body.style.cssText = "margin:0;overflow:hidden;background:#000;";
  host = { root, resolveAsset: src => `${assetBase}${src.slice("assets/".length)}` };
  renderNleFrame(host, project, 0, { playing: false });
};

state.__glintNleSeek = async tMs => {
  if (!host || !project) throw new Error("NLE harness not initialised");
  renderNleFrame(host, project, tMs, { playing: false });
  await syncNleMedia(host);
  // Let styles/layout settle before the screenshot.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};
