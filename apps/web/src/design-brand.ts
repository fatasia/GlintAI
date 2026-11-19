import { parseBrandPack } from "@glintai/design-tokens/brand";
import type { DesignDocument } from "./design-artifacts";

export const BRAND_DRAFT_KEY = "glint:brand-draft:v1";
export const projectBrandKey = (projectId: string) => `glint:brand-project.v1:${projectId}`;
export type BrandTheme = { name: string; accent: string; bg: string; text: string; logoText?: string; displayFont?: string };

function validTheme(value: unknown): value is BrandTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const theme = value as BrandTheme;
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
  return text(theme.name, 60) && [theme.accent, theme.bg, theme.text].every(color => typeof color === "string" && /^#[\da-f]{6}$/i.test(color)) &&
    (theme.logoText === undefined || text(theme.logoText, 24)) &&
    (theme.displayFont === undefined || (text(theme.displayFont, 400) && /^[\p{L}\p{N}\s,'"_-]+$/u.test(theme.displayFont)));
}

function packToTheme(raw: unknown): BrandTheme | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as { name?: unknown; logoText?: unknown; colors?: unknown; fonts?: unknown };
  if (typeof input.name !== "string" || input.name.length > 60 || !input.colors || typeof input.colors !== "object" || Array.isArray(input.colors) ||
    (input.logoText !== undefined && (typeof input.logoText !== "string" || input.logoText.length > 24)) ||
    (input.fonts !== undefined && (!input.fonts || typeof input.fonts !== "object" || Array.isArray(input.fonts)))) return null;
  if (input.fonts && Object.values(input.fonts).some(value => typeof value !== "string" || value.length > 400)) return null;
  const parsed = parseBrandPack(raw);
  if (!parsed.pack) return null;
  const pack = parsed.pack;
  if (!pack) return null;
  const theme: BrandTheme = {
    name: pack.name,
    accent: pack.colors.accent ?? "#e0533d",
    bg: pack.colors.bg ?? "#0a0a0b",
    text: pack.colors.text ?? "#f4f1ea",
    ...(pack.logoText ? { logoText: pack.logoText } : {}),
    ...(pack.fonts?.display ? { displayFont: pack.fonts.display } : {}),
  };
  return validTheme(theme) ? theme : null;
}

function readKey(key: string): BrandTheme | null {
  try { const raw = localStorage.getItem(key) ?? "null"; return raw.length <= 4096 ? packToTheme(JSON.parse(raw)) : null; } catch { return null; }
}

/** A project can pin its own brand; otherwise it follows the studio-wide draft. */
export function readBrandTheme(projectId?: string): { theme: BrandTheme | null; source: "project" | "studio" | "none" } {
  if (projectId) { const pinned = readKey(projectBrandKey(projectId)); if (pinned) return { theme: pinned, source: "project" }; }
  const studio = readKey(BRAND_DRAFT_KEY);
  return studio ? { theme: studio, source: "studio" } : { theme: null, source: "none" };
}

export function readProjectBrandTheme(projectId: string, storage: Pick<Storage, "getItem"> = localStorage): BrandTheme | null {
  const raw = storage.getItem(projectBrandKey(projectId));
  if (raw === null) return null;
  let theme: BrandTheme | null = null;
  try { if (raw.length <= 4096) theme = packToTheme(JSON.parse(raw)); } catch { /* Report invalid pinned data, never fall back silently. */ }
  if (!theme) throw new Error("项目固定品牌损坏；版本操作已停止，旧数据未覆盖。");
  return theme;
}
export function projectBrandRaw(theme: BrandTheme): string {
  if (!validTheme(theme)) throw new Error("品牌包不完整或包含不安全样式，无法固定到项目。");
  return JSON.stringify({ name: theme.name, colors: { accent: theme.accent, bg: theme.bg, text: theme.text }, ...(theme.logoText ? { logoText: theme.logoText } : {}), ...(theme.displayFont ? { fonts: { display: theme.displayFont } } : {}) });
}
export function pinBrandToProject(projectId: string, theme: BrandTheme): void {
  if (!validTheme(theme)) throw new Error("品牌包不完整或包含不安全样式，无法固定到项目。");
  const pack = parseBrandPack({ name: theme.name, colors: { accent: theme.accent, bg: theme.bg, text: theme.text }, ...(theme.logoText ? { logoText: theme.logoText } : {}), ...(theme.displayFont ? { fonts: { display: theme.displayFont } } : {}) }).pack;
  if (!pack) throw new Error("品牌包不完整，无法固定到项目。");
  localStorage.setItem(projectBrandKey(projectId), JSON.stringify(pack));
}

export function clearProjectBrand(projectId: string): void { localStorage.removeItem(projectBrandKey(projectId)); }

/** Brand variables are additive: documents that never mention them render exactly as before. */
export function brandTokens(brand: BrandTheme | null): Record<string, string> {
  if (!validTheme(brand)) return {};
  return {
    "--brand-accent": brand.accent,
    "--brand-bg": brand.bg,
    "--brand-text": brand.text,
    ...(brand.displayFont ? { "--brand-font": brand.displayFont } : {}),
    // 已使用 --accent 的设计也跟随品牌。
    "--accent": brand.accent,
  };
}

/** 仅显式导出时创建副本，不回写编辑器源码、历史或持久化数据。 */
export function brandExportDocument(document: DesignDocument, brand: BrandTheme | null): DesignDocument {
  if (brand === null) return document;
  if (!validTheme(brand)) throw new Error("品牌变量无效，请重新选择品牌后导出。");
  const css = `:root{${Object.entries(brandTokens(brand)).map(([key, value]) => `${key}:${value}`).join(";")}}`;
  return { ...document, pages: document.pages.map(page => {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const style = doc.createElement("style"); style.setAttribute("data-glint-export-brand", "true"); style.textContent = css;
    doc.head.appendChild(style);
    return { ...page, html: `<!doctype html>\n${doc.documentElement.outerHTML}` };
  }) };
}
