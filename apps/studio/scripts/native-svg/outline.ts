import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";

/** Text paths are static across most frames; scanning fonts for each frame is not. */
export function createTextOutliner(font: NonNullable<ResvgRenderOptions["font"]>, width: number, height: number, family: string) {
  const cache = new Map<string, string>();
  return (svg: string): string => svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, block => {
    const cached = cache.get(block);
    if (cached !== undefined) return cached;
    const document = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${family.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${block}</svg>`, { font }).toString();
    const inner = document.slice(document.indexOf(">") + 1, document.lastIndexOf("</svg>")).replace(/<defs\s*\/>/, "");
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(block, inner);
    return inner;
  });
}
