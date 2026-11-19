import pptxgen from "pptxgenjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { checkDesignAbort, designError } from "./design-export-contract.mjs";
import { slideTransitionXml } from "../src/design-transition.ts";

const SLIDE_WIDTH = 13.333333, SLIDE_HEIGHT = 7.5, PIXELS_PER_INCH = 96;
/** Native page switches live in slideN.xml after the color mapping; injection keeps pptxgenjs untouched. */
export function injectSlideTransitions(buffer, pages) {
  const archive = unzipSync(new Uint8Array(buffer));
  let injected = 0;
  for (let i = 0; i < pages.length; i++) {
    const xml = slideTransitionXml(pages[i]?.transition);
    const entry = `ppt/slides/slide${i + 1}.xml`;
    if (!xml || !archive[entry]) continue;
    const content = strFromU8(archive[entry]);
    if (content.includes("<p:transition")) continue;
    const marker = "</p:clrMapOvr>";
    const next = content.includes(marker) ? content.replace(marker, `${marker}${xml}`) : content.replace("</p:sld>", `${xml}</p:sld>`);
    if (next === content) throw designError("PPTX 页面切换写入失败，请重试导出。", 500);
    archive[entry] = strToU8(next);
    injected++;
  }
  return { buffer: Buffer.from(zipSync(archive, { level: 6 })), injected };
}
export async function editableDesignPptx(document, prepared, layouts, { signal } = {}) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "GLINT_DESIGN", width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  pptx.layout = "GLINT_DESIGN"; pptx.author = "Glint"; pptx.subject = "可编辑设计导出"; pptx.title = document.title; pptx.company = "Glint"; pptx.lang = "zh-CN";
  let editableElements = 0;
  for (let i = 0; i < prepared.pages.length; i++) {
    checkDesignAbort(signal);
    const slide = pptx.addSlide(), layout = layouts[i], page = prepared.pages[i];
    const scale = Math.min(SLIDE_WIDTH / layout.width, SLIDE_HEIGHT / layout.height);
    slide.addNotes(page.notes ?? "");
    for (const item of layout.items) {
      if (item.w <= 0 || item.h <= 0 || item.x < -1 || item.y < -1) continue;
      const rect = { x: Math.max(0, item.x * scale), y: Math.max(0, item.y * scale), w: Math.min(SLIDE_WIDTH, item.w * scale), h: Math.min(SLIDE_HEIGHT, item.h * scale) };
      const transparency = Math.round((1 - (item.opacity ?? 1)) * 100);
      if (item.type === "shape") {
        slide.addShape(item.radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { ...rect, rectRadius: Math.min(item.radius * scale, .5), radius: Math.min(item.radius * scale, .5), fill: item.fill?.alpha ? { color: item.fill.hex, transparency: Math.max(transparency, Math.round((1 - item.fill.alpha) * 100)) } : { color: "FFFFFF", transparency: 100 }, line: { color: item.line?.hex ?? "FFFFFF", transparency: item.lineWidth && item.line?.alpha ? 0 : 100, width: Math.max(0, (item.lineWidth ?? 0) * scale * 72) } });
        editableElements++;
      } else if (item.type === "text") {
        slide.addText(item.text, { ...rect, margin: 0, breakLine: false, fontFace: item.fontFace || "Microsoft YaHei", fontSize: Math.max(1, item.fontSize * scale * 72), bold: item.bold, italic: item.italic, color: item.color?.hex ?? "000000", transparency, align: ["left", "center", "right", "justify"].includes(item.align) ? item.align : "left", valign: "mid", fit: "shrink", paraSpaceAfterPt: 0 });
        editableElements++;
      } else if (["image", "raster"].includes(item.type)) {
        slide.addImage({ ...rect, data: item.data, transparency });
        if (item.type === "image") editableElements++;
      }
    }
  }
  if (!editableElements) throw designError("页面没有可转换的文字、图片或基础形状，无法生成可编辑 PPTX；请改用 PNG/PDF。", 422);
  prepared.warnings.add("PPTX 的文字、位图和基础形状可独立编辑；字体替换、复杂排版与 CSS 效果可能与浏览器不同。");
  const output = await pptx.write({ outputType: "nodebuffer", compression: true });
  checkDesignAbort(signal);
  const { buffer, injected } = injectSlideTransitions(Buffer.from(output), document.pages);
  if (injected) prepared.warnings.add(`已写入 ${injected} 页原生切换；旧版本 Office 可能忽略精确时长，改用慢/中/快档。`);
  return { buffer, editableElements };
}
