import { STYLE_PACKS, themes, type ThemeName } from "@glintai/design-tokens";

export type Rgb = [number, number, number];
export interface StyleSuggestion { name: ThemeName; label: string; reason: string; score: number }

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
function rgb(hex: string): Rgb {
  const value = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!value) return [0, 0, 0];
  const integer = parseInt(value[1]!, 16);
  return [(integer >> 16) & 0xff, (integer >> 8) & 0xff, integer & 0xff];
}
function luminance(color: Rgb): number { return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255; }
function saturation(color: Rgb): number {
  const max = Math.max(...color), min = Math.min(...color);
  return max === 0 ? 0 : (max - min) / max;
}
function warmth(color: Rgb): number { return clamp01(0.5 + (color[0] - color[2]) / 510); }

/**
 * Heuristic only: compares the reference's average luma/saturation/warmth with
 * each pack's background and accent. It does not recognise objects, people or a
 * named photographic look.
 */
export function suggestStylePacks(samples: readonly Rgb[]): StyleSuggestion[] {
  if (!samples.length) throw new Error("参考图没有可用像素，请换一张图片。");
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const luma = average(samples.map(luminance));
  const sat = average(samples.map(saturation));
  const warm = average(samples.map(warmth));
  return STYLE_PACKS.map(pack => {
    const tokens = themes[pack.name];
    const bg = rgb(tokens.colors.bg);
    const accent = rgb(tokens.colors.accent);
    const packLuma = luminance(bg);
    const packSat = saturation(bg) * 0.5 + saturation(accent) * 0.5;
    const packWarm = warmth(bg) * 0.7 + warmth(accent) * 0.3;
    const score = Math.abs(luma - packLuma) * 1.4 + Math.abs(sat - packSat) * 0.8 + Math.abs(warm - packWarm) * 0.6;
    const reasons: string[] = [];
    if (luma < 0.42 && packLuma < 0.3) reasons.push("明暗接近（深底）");
    else if (luma > 0.62 && packLuma > 0.6) reasons.push("明暗接近（亮底）");
    else if (Math.abs(luma - packLuma) <= 0.18) reasons.push("明暗接近");
    if (Math.abs(sat - packSat) <= 0.18) reasons.push(sat > 0.45 ? "饱和度偏高" : "饱和度克制");
    if (Math.abs(warm - packWarm) <= 0.12) reasons.push(warm > 0.55 ? "偏暖" : warm < 0.45 ? "偏冷" : "中性色温");
    return { name: pack.name, label: pack.label, reason: reasons.slice(0, 3).join("、") || "综合色调最接近", score: Math.round(score * 1000) / 1000 };
  }).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 2);
}
