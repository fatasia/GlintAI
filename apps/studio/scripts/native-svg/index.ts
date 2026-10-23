import type { Scene, SceneScriptProject } from "@glintai/scenescript";
import { cameraTransform, beatPulseScale, sceneDurationMs, evaluateElements, wrapSvgEffects, DEFAULT_TRANSITION_MS, type SceneElement } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { renderChart } from "./charts";
import { clamp, eased, mix, textBlock, xml } from "./text";

export function supportsNativeScene(scene: Scene): boolean {
  return ["title", "bullets", "definition", "quote", "comparison", "diagram", "chart", "code"].includes(scene.kind);
}

export interface SvgOptions { width?: number; height?: number; plate?: boolean; previousScene?: Scene; overlayOnly?: boolean }

export function sharedElementPositions(scene: Scene, previous: Scene | undefined, progress: number) {
  const t = clamp(progress);
  // Critically damped spring, normalized so endpoints land exactly.
  const settle = (v: number) => 1 - (1 + 8 * v) * Math.exp(-8 * v);
  const p = settle(t) / settle(1);
  return (scene.sharedElements ?? []).map(element => {
    const source = scene.transition?.in === "magic-move" ? previous?.sharedElements?.find(item => item.key === element.key) : undefined;
    return { ...element, x: mix(source?.x ?? element.x, element.x, p), y: mix(source?.y ?? element.y, element.y, p), fontSize: mix(source?.fontSize ?? element.fontSize ?? 48, element.fontSize ?? 48, p) };
  });
}

/** Editable object layer: the same evaluator drives the Remotion overlay. */
export function renderElementLayer(scene: Scene, w: number, h: number, size: number, timeMs: number, theme: ReturnType<typeof resolveTheme>): string {
  return evaluateElements(scene, timeMs).map(state => {
    const element = state.element;
    const cx = state.x * w, cy = state.y * h;
    const opacity = Math.min(1, Math.max(0, state.opacity));
    const transform = `translate(${cx} ${cy}) rotate(${state.rotate}) scale(${state.scale})`;
    if (element.kind === "text") {
      const fill = element.color ?? theme.colors.text;
      return `<g opacity="${opacity}" transform="${transform}"><text x="0" y="0" dy="0.35em" text-anchor="middle" font-family="${xml(theme.fonts.body)}" font-size="${(element.fontSize ?? 48) * size}" font-weight="${element.weight ?? 700}" fill="${fill}">${xml(element.text)}</text></g>`;
    }
    const width = element.w * w, height = element.h * h;
    return `<g opacity="${opacity}" transform="${transform}"><rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" rx="${(element.radius ?? 0) * size}" fill="${element.fill}"/></g>`;
  }).join("");
}
export function renderSceneSvg(project: SceneScriptProject, scene: Scene, frame: number, options: SvgOptions = {}): string {
  if (!supportsNativeScene(scene)) throw new Error(`Native SVG does not support ${scene.kind}; choose the browser backend`);
  const dimensions = project.aspect === "9:16" ? [1080, 1920] : project.aspect === "1:1" ? [1080, 1080] : [1920, 1080];
  const w = options.width ?? dimensions[0]!, h = options.height ?? dimensions[1]!;
  const fps = project.fps ?? 30, duration = sceneDurationMs(scene), theme = resolveTheme(project.theme), c = theme.colors;
  const frames = Math.max(1, Math.round(duration / 1000 * fps));
  const currentFrame = Math.min(frames - 1, Math.max(0, frame));
  const p = eased(currentFrame / (fps * 0.8));
  const size = Math.min(w, h) / 1080;
  const tx = (text: string, x: number, y: number, width: number, font: number, color = c.text, height?: number, weight = 400, family = theme.fonts.body) => textBlock(text, x, y, width, font * size, color, { height, weight, family });
  let heading = "heading" in scene ? scene.heading ?? "" : "";
  let content = "";
  const inset = w * 0.1, areaW = w * 0.8;
  switch (scene.kind) {
    case "title":
      content = tx(scene.title, inset, h * 0.43, areaW, theme.fontSizes.display, c.text, h * 0.32, 700, theme.fonts.display) + tx(scene.subtitle ?? "", inset, h * 0.68, areaW, theme.fontSizes.h2, c.textMuted, h * 0.12, 400, theme.fonts.body);
      break;
    case "definition":
      heading = scene.term;
      content = `<rect x="${inset}" y="${h * 0.32}" width="${areaW}" height="${h * 0.4}" rx="${theme.radius}" fill="${c.surface}"/>` + tx(scene.definition, inset + 35 * size, h * 0.43, areaW - 70 * size, 52, c.text, h * 0.28);
      break;
    case "quote":
      content = tx("“", inset, h * 0.34, areaW, 120, c.accent, undefined, 400, theme.fonts.display) + tx(scene.text, inset, h * 0.43, areaW, theme.fontSizes.h1, c.text, h * 0.29, 400, theme.fonts.display) + tx(scene.attribution ?? "", inset, h * 0.78, areaW, theme.fontSizes.caption, c.textMuted);
      break;
    case "bullets": {
      const pageSize = 5, pages = Math.ceil(scene.items.length / pageSize);
      const page = Math.min(pages - 1, Math.floor(currentFrame / frames * pages));
      const items = scene.items.slice(page * pageSize, page * pageSize + pageSize);
      const rowH = h * 0.52 / items.length;
      content = items.map((item, i) => `<g opacity="${eased((currentFrame / fps - i * 0.08) / 0.6)}"><rect x="${inset}" y="${h * 0.3 + i * rowH - 25 * size}" width="${48 * size}" height="${48 * size}" rx="8" fill="${c.accent}" opacity="0.16"/>${tx(String(page * pageSize + i + 1).padStart(2, "0"), inset + 7 * size, h * 0.3 + i * rowH + 10 * size, 45 * size, 24, c.accent)}${tx(item, inset + 80 * size, h * 0.3 + i * rowH + 10 * size, areaW - 90 * size, 42, c.text, rowH * 0.86)}</g>`).join("");
      break;
    }
    case "comparison": {
      const vertical = w < h, cw = vertical ? areaW : areaW * 0.47, cardH = vertical ? h * 0.23 : h * 0.48;
      content = [scene.left, scene.right].map((side, i) => {
        const x = inset + (vertical ? 0 : i * areaW * 0.53), y = h * 0.28 + (vertical ? i * h * 0.27 : 0);
        return `<rect x="${x}" y="${y}" width="${cw}" height="${cardH}" rx="${theme.radius}" fill="${c.surface}" stroke="${c.border}"/>${tx(side.label, x + 28 * size, y + 65 * size, cw - 56 * size, 42, i ? c.accent2 : c.accent, cardH * 0.16, 700)}${tx(side.points.map(point => `• ${point}`).join("\n"), x + 28 * size, y + 128 * size, cw - 56 * size, 33, c.text, cardH * 0.63)}`;
      }).join("");
      break;
    }
    case "diagram": {
      const vertical = w < h;
      const stepW = vertical ? areaW : areaW / scene.steps.length * 0.88;
      content = scene.steps.map((step, i) => {
        const x = inset + (vertical ? 0 : i * areaW / scene.steps.length), y = h * 0.32 + (vertical ? i * h * 0.09 : 0), sh = vertical ? h * 0.077 : h * 0.3;
        return `<rect x="${x}" y="${y}" width="${stepW}" height="${sh}" rx="${theme.radius}" fill="${c.surface}" stroke="${c.border}"/>${tx(`${i + 1}. ${step.label}`, x + 20 * size, y + 52 * size, stepW - 40 * size, 34, c.accent, sh * 0.5, 700)}${tx(step.note ?? "", x + 20 * size, y + sh * 0.6, stepW - 40 * size, 26, c.textMuted, sh * 0.3)}`;
      }).join("");
      break;
    }
    case "code":
      content = `<rect x="${inset}" y="${h * 0.27}" width="${areaW}" height="${h * 0.52}" rx="${theme.radius}" fill="${c.surface}" stroke="${c.border}"/>` + tx(scene.code, inset + 30 * size, h * 0.34, areaW - 60 * size, 30, c.text, h * 0.42);
      break;
    case "chart": content = renderChart(scene, currentFrame, fps, w, h, theme); break;
  }
  if (options.overlayOnly) content = "";
  const transitionMs = scene.transition?.durationMs ?? DEFAULT_TRANSITION_MS;
  const progress = clamp(currentFrame / fps * 1000 / transitionMs), enter = eased(progress);
  const kind = scene.transition?.in;
  let transform = "", opacity = scene.transition && kind !== "magic-move" ? enter : 1;
  if (kind === "slide-left" || kind === "slide-right") transform = `translate(${(kind === "slide-left" ? 1 : -1) * (1 - enter) * w * 0.08} 0)`;
  if (kind === "slide-up") transform = `translate(0 ${(1 - enter) * h * 0.08})`;
  if (kind === "zoom-punch" || kind === "flash") { const scale = 1 + (1 - enter) * 0.15; transform = `translate(${w / 2} ${h / 2}) scale(${scale}) translate(${-w / 2} ${-h / 2})`; }
  if (kind === "flip") transform = `translate(0 ${h / 2}) scale(1 ${Math.max(0.01, enter)}) translate(0 ${-h / 2})`;
  const camera = cameraTransform(scene.camera, currentFrame, frames);
  const pulse = beatPulseScale(scene.beatPulse, currentFrame / fps * 1000);
  const cameraSvg = `translate(${w / 2 + camera.translateX * size} ${h / 2 + camera.translateY * size}) scale(${camera.scale * pulse}) translate(${-w / 2} ${-h / 2})`;
  const shared = sharedElementPositions(scene, options.previousScene, progress).map(e => textBlock(e.text, e.x * w, e.y * h, w * 0.8, e.fontSize * size, e.color ?? c.accent, { weight: 700 })).join("");
  const words = scene.narration.segments?.flatMap(segment => segment.words ?? []) ?? [];
  const ms = currentFrame / fps * 1000;
  const elementLayer = renderElementLayer(scene, w, h, size, ms, theme);
  // Only scene-local subtitles follow the audio offset; elements and camera keep their visual clock.
  const offsetMs = scene.narration.audioOffsetMs ?? 0;
  const captionMs = ms - (Number.isFinite(offsetMs) ? offsetMs : 0);
  const pageSize = 24;
  let captionStart = Math.max(0, Math.floor((words.length - 1) / pageSize) * pageSize);
  for (let start = 0; start < words.length; start += pageSize) {
    if (words[Math.min(start + pageSize, words.length) - 1]!.endMs > captionMs) {
      captionStart = start;
      break;
    }
  }
  const caption = words.length ? words.slice(captionStart, captionStart + pageSize).map(word => word.text).join("") : scene.narration.text;
  const clip = kind === "wipe" ? `<rect width="${w * enter}" height="${h}"/>` : kind === "iris" ? `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.hypot(w, h) * enter}"/>` : `<rect width="${w}" height="${h}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${xml(theme.fonts.body)}"><defs><clipPath id="entrance">${clip}</clipPath><filter id="blur"><feGaussianBlur stdDeviation="${kind === "blur" ? (1 - enter) * 10 : 0}"/></filter></defs><rect width="${w}" height="${h}" fill="${options.overlayOnly ? "none" : c.bg}"/><g clip-path="url(#entrance)" opacity="${opacity}" transform="${transform}" filter="url(#blur)"><g transform="${cameraSvg}">${tx(heading, inset, h * 0.17, areaW, theme.fontSizes.h1, c.text, h * 0.12, 700, theme.fonts.display)}<g opacity="${p}">${content}</g>${options.overlayOnly || options.plate ? "" : elementLayer}</g></g>${shared}${options.plate || captionMs < 0 ? "" : tx(caption, inset, h * 0.9, areaW, 30, c.textMuted, h * 0.085)}<rect y="${h - 5}" width="${w * clamp(currentFrame / frames)}" height="5" fill="${c.accent}"/></svg>`;
  return wrapSvgEffects(svg, scene.effects ?? [], ms);
}