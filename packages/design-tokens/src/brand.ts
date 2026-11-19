import { themes, type DesignTokens, type ThemeName } from "./index";

/**
 * W5 brand kit (TEAM-01): a named override layer on top of an installed theme.
 * The engine merges tokens and checks WCAG contrast before anything renders —
 * a brand color that fails legibility is flagged at definition time, not
 * discovered in a rendered frame. Zero dependencies, like the token package.
 */

export interface BrandPack {
  name: string;
  /** Text logo mark (image logos go through the asset pipeline, not tokens). */
  logoText?: string;
  colors: {
    bg?: string;
    surface?: string;
    text?: string;
    textMuted?: string;
    accent: string;
    accent2?: string;
  };
  fonts?: { display?: string; body?: string };
}

const COLOR_KEYS = ["bg", "surface", "text", "textMuted", "accent", "accent2"] as const;
const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
const clampText = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Hand-rolled validation (the tokens package stays dependency-free); issues never throw. */
export function parseBrandPack(value: unknown): { pack?: BrandPack; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object") return { issues: ["品牌包必须是对象"] };
  const raw = value as Record<string, unknown>;
  const name = clampText(raw.name, 60);
  if (!name) issues.push("缺少品牌名 name");
  const colorsRaw = (raw.colors ?? {}) as Record<string, unknown>;
  if (!isHex(colorsRaw.accent)) issues.push("colors.accent 必须是 #RRGGBB");
  const colors: BrandPack["colors"] = { accent: isHex(colorsRaw.accent) ? colorsRaw.accent : "#9b8bfb" };
  for (const key of COLOR_KEYS) {
    if (key === "accent") continue;
    const cell = colorsRaw[key];
    if (cell === undefined) continue;
    if (!isHex(cell)) { issues.push(`colors.${key} 必须是 #RRGGBB`); continue; }
    (colors as Record<string, string>)[key] = cell;
  }
  let fonts: BrandPack["fonts"];
  if (raw.fonts && typeof raw.fonts === "object") {
    const fontsRaw = raw.fonts as Record<string, unknown>;
    fonts = {};
    for (const key of ["display", "body"] as const) {
      const cell = clampText(fontsRaw[key], 400);
      if (cell) fonts[key] = cell;
    }
  }
  const logoText = clampText(raw.logoText, 24);
  if (!issues.length) return { pack: { name, ...(logoText ? { logoText } : {}), colors, ...(fonts ? { fonts } : {}) }, issues };
  return { issues };
}

/** WCAG relative luminance of a #RRGGBB color. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (index: number) => {
    const raw = parseInt(value.slice(index * 2, index * 2 + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio between two #RRGGBB colors, rounded to 2 decimals. */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return Math.round((lighter + 0.05) / (darker + 0.05) * 100) / 100;
}

/**
 * AA legibility issues for the merged palette: body text needs 4.5:1 on bg and
 * surface; muted text 4.5:1 on bg; accents are decorative-but-readable (3:1)
 * against bg. Issues are advisory — the merge still succeeds.
 */
export function brandContrastIssues(brand: BrandPack): string[] {
  const issues: string[] = [];
  const check = (label: string, foreground: string, background: string, minimum: number) => {
    const ratio = contrastRatio(foreground, background);
    if (ratio < minimum) issues.push(`${label} 对比度 ${ratio}:1 低于 AA 的 ${minimum}:1`);
  };
  const base = themes["glint-dark"];
  const bg = brand.colors.bg ?? base.colors.bg;
  const surface = brand.colors.surface ?? base.colors.surface;
  check("正文 text/bg", brand.colors.text ?? base.colors.text, bg, 4.5);
  check("正文 text/surface", brand.colors.text ?? base.colors.text, surface, 4.5);
  check("弱化 textMuted/bg", brand.colors.textMuted ?? base.colors.textMuted, bg, 4.5);
  check("强调 accent/bg", brand.colors.accent, bg, 3);
  if (brand.colors.accent2) check("次强调 accent2/bg", brand.colors.accent2, bg, 3);
  return issues;
}

/** Merge a brand pack over an installed theme; schema-level validation already ran. */
export function brandTheme(base: ThemeName, brand: BrandPack): { theme: DesignTokens; issues: string[] } {
  const source = themes[base];
  const issues = brandContrastIssues(brand);
  return {
    issues,
    theme: {
      ...source,
      colors: { ...source.colors, ...brand.colors },
      fonts: brand.fonts ? { ...source.fonts, ...brand.fonts } : source.fonts,
    },
  };
}
