export type ThemeName =
  | "glint-dark"
  | "glint-light"
  | "cream-editorial"
  | "mint-clean"
  | "bold-poster"
  | "hand-note"
  | "retro-news"
  | "blackboard-tech"
  | "whiteboard"
  | "blueprint";

export interface DesignTokens {
  colors: {
    bg: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accent2: string;
  };
  fonts: {
    display: string;
    body: string;
    mono: string;
  };
  /** Font sizes in px, measured against a 1080p-tall canvas. */
  fontSizes: {
    display: number;
    h1: number;
    h2: number;
    body: number;
    caption: number;
  };
  radius: number;
  motion: {
    fadeMs: number;
  };
  effects: {
    cardShadow: string;
    /** Inset top highlight for machined, nested surfaces. */
    innerHighlight: string;
    /** Hairline stroke: quieter than a colored border. */
    hairline: string;
  };
}

export const THEME_NAMES = [
  "glint-dark",
  "glint-light",
  "cream-editorial",
  "mint-clean",
  "bold-poster",
  "hand-note",
  "retro-news",
  "blackboard-tech",
  "whiteboard",
  "blueprint",
] as const;

/** Embeddable fonts whose bytes we do NOT bundle; the CSS stack stays system-first. */
export const AESTHETIC_FONTS = {
  sans: { name: "Noto Sans SC / Source Han Sans", version: "2.004R", license: "OFL-1.1", source: "https://github.com/adobe-fonts/source-han-sans" },
  serif: { name: "Noto Serif SC / Source Han Serif", version: "2.003R", license: "OFL-1.1", source: "https://github.com/adobe-fonts/source-han-serif" },
  inter: { name: "Inter", version: "4.1", license: "OFL-1.1", source: "https://github.com/rsms/inter" },
  mono: { name: "JetBrains Mono", version: "2.304", license: "OFL-1.1", source: "https://github.com/JetBrains/JetBrainsMono" },
  /** System handwriting face: referenced, never redistributed. */
  kaiti: { name: "KaiTi / STKaiti", version: "system", license: "system-stack", source: "system-installed" },
} as const;
type FontKey = keyof typeof AESTHETIC_FONTS;

/** Data-only aesthetic recipe. It describes intent; it never embeds font files or licensed look data. */
export interface StylePackAesthetic {
  version: 1;
  typography: {
    display: FontKey;
    body: FontKey;
    mono: FontKey;
    /** Rendered px sizes at 1080p; must equal the theme's fontSizes. */
    scale: { display: number; h1: number; h2: number; body: number; caption: number };
    notes: string;
  };
  composition: { grid: string; safeArea: string; density: "airy" | "balanced" | "dense"; notes: string };
  motion: { easing: string; entranceMs: number; reducedMotion: string };
  pacing: { shotMs: [number, number]; holdMs: number; cutPattern: string };
  sound: { mood: string; targetLufs: number; duckingDb: number };
  /** Self-authored descriptions for review; no third-party stills are shipped. */
  referencePreviews: string[];
}

/** Style-pack metadata for style pickers, `glint styles` and the skill docs. */
export interface StylePackMeta {
  name: ThemeName;
  label: string;
  category: "studio" | "hand-drawn" | "print" | "tech";
  /** One line: what it looks like and what content it fits. */
  summary: string;
  /** Craft rules the composer should respect when using this pack. */
  rules: string[];
  /** Typography, composition, motion, pacing and sound — the part after colour. */
  aesthetic: StylePackAesthetic;
}


// Serif display stack: editorial, consumer-premium titles (falls back to
// Songti on stock Windows; sans stays for body).
const SERIF_DISPLAY =
  '"Noto Serif SC", "Source Han Serif SC", "STZhongsong", "SimSun", "PingFang SC", serif';
const SANS_BODY =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

export const themes: Record<ThemeName, DesignTokens> = {
  "glint-dark": {
    colors: {
      bg: "#121016",
      surface: "#1c1924",
      border: "#2b2735",
      text: "#f5f3f7",
      textMuted: "#a09aae",
      accent: "#9b8bfb",
      accent2: "#ff9d8a",
    },
    fonts: {
      display: SERIF_DISPLAY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 104,
      h1: 66,
      h2: 48,
      body: 36,
      caption: 30,
    },
    radius: 24,
    motion: { fadeMs: 420 },
    effects: {
      cardShadow: "0 32px 90px rgba(10, 8, 20, 0.5)",
      innerHighlight: "inset 0 1px 1px rgba(255, 255, 255, 0.12)",
      hairline: "1px solid rgba(245, 243, 247, 0.08)",
    },
  },
  "glint-light": {
    colors: {
      bg: "#faf9fc",
      surface: "#ffffff",
      border: "#e8e4f0",
      text: "#211d2a",
      textMuted: "#6f6980",
      accent: "#6d5ae0",
      accent2: "#e26d5a",
    },
    fonts: {
      display: SERIF_DISPLAY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 104,
      h1: 66,
      h2: 48,
      body: 36,
      caption: 30,
    },
    radius: 24,
    motion: { fadeMs: 420 },
    effects: {
      cardShadow: "0 28px 70px rgba(33, 29, 42, 0.10)",
      innerHighlight: "inset 0 1px 1px rgba(255, 255, 255, 0.65)",
      hairline: "1px solid rgba(33, 29, 42, 0.08)",
    },
  },
  "cream-editorial": {
    colors: {
      bg: "#f7f1e6",
      surface: "#fffdf8",
      border: "#e8dcc8",
      text: "#2b2116",
      textMuted: "#7a6a52",
      accent: "#c2571f",
      accent2: "#1f6e5c",
    },
    fonts: {
      display: SERIF_DISPLAY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 104,
      h1: 66,
      h2: 48,
      body: 36,
      caption: 30,
    },
    radius: 20,
    motion: { fadeMs: 420 },
    effects: {
      cardShadow: "0 24px 64px rgba(80, 60, 30, 0.14)",
      innerHighlight: "inset 0 1px 1px rgba(255, 255, 255, 0.8)",
      hairline: "1px solid rgba(80, 60, 30, 0.10)",
    },
  },
  "mint-clean": {
    colors: {
      bg: "#f4faf8",
      surface: "#ffffff",
      border: "#d8ece3",
      text: "#12332a",
      textMuted: "#5c7f74",
      accent: "#0e9f77",
      accent2: "#f2a03d",
    },
    fonts: {
      display: SANS_BODY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 96,
      h1: 62,
      h2: 46,
      body: 36,
      caption: 30,
    },
    radius: 18,
    motion: { fadeMs: 360 },
    effects: {
      cardShadow: "0 20px 56px rgba(18, 51, 42, 0.10)",
      innerHighlight: "inset 0 1px 1px rgba(255, 255, 255, 0.7)",
      hairline: "1px solid rgba(18, 51, 42, 0.08)",
    },
  },
  "bold-poster": {
    colors: {
      bg: "#0a0a0a",
      surface: "#161616",
      border: "#2c2c2c",
      text: "#ffffff",
      textMuted: "#9e9e9e",
      accent: "#ffd400",
      accent2: "#ff3d00",
    },
    fonts: {
      display: SANS_BODY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 128,
      h1: 76,
      h2: 52,
      body: 38,
      caption: 30,
    },
    radius: 4,
    motion: { fadeMs: 280 },
    effects: {
      cardShadow: "0 24px 64px rgba(0, 0, 0, 0.6)",
      innerHighlight: "inset 0 2px 0 rgba(255, 212, 0, 0.9)",
      hairline: "1px solid rgba(255, 255, 255, 0.14)",
    },
  },
  "hand-note": {
    colors: {
      bg: "#f6f1e3",
      surface: "#fdf9ee",
      border: "#d9cdae",
      text: "#33302a",
      textMuted: "#8a8069",
      accent: "#d95d39",
      accent2: "#3a6ea5",
    },
    fonts: {
      display:
        '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", "Segoe Print", "Comic Sans MS", cursive',
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    },
    fontSizes: {
      display: 100,
      h1: 64,
      h2: 48,
      body: 36,
      caption: 30,
    },
    radius: 8,
    motion: { fadeMs: 380 },
    effects: {
      cardShadow: "0 14px 36px rgba(90, 70, 30, 0.14)",
      innerHighlight: "inset 0 1px 1px rgba(255, 255, 255, 0.75)",
      hairline: "1px dashed rgba(51, 48, 42, 0.35)",
    },
  },
  "retro-news": {
    colors: {
      bg: "#f1ead9",
      surface: "#f8f2e4",
      border: "#c9bda0",
      text: "#211d17",
      textMuted: "#6e6450",
      accent: "#8c1f28",
      accent2: "#33506b",
    },
    fonts: {
      display: SERIF_DISPLAY,
      body: SERIF_DISPLAY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    },
    fontSizes: {
      display: 108,
      h1: 68,
      h2: 48,
      body: 34,
      caption: 28,
    },
    radius: 2,
    motion: { fadeMs: 340 },
    effects: {
      cardShadow: "none",
      innerHighlight: "none",
      hairline: "1px solid rgba(33, 29, 23, 0.45)",
    },
  },
  "blackboard-tech": {
    colors: {
      bg: "#101418",
      surface: "#171d24",
      border: "#2a333d",
      text: "#e8edf2",
      textMuted: "#8b98a5",
      accent: "#4fd1c5",
      accent2: "#f6ad55",
    },
    fonts: {
      display: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace',
    },
    fontSizes: {
      display: 96,
      h1: 62,
      h2: 46,
      body: 36,
      caption: 30,
    },
    radius: 6,
    motion: { fadeMs: 320 },
    effects: {
      cardShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
      innerHighlight: "inset 0 1px 1px rgba(79, 209, 197, 0.18)",
      hairline: "1px solid rgba(79, 209, 197, 0.28)",
    },
  },
  "whiteboard": {
    colors: {
      bg: "#fdfdfa",
      surface: "#ffffff",
      border: "#e2e2dc",
      text: "#22262b",
      textMuted: "#6b7280",
      accent: "#2965c8",
      accent2: "#d13b3b",
    },
    fonts: {
      display: SANS_BODY,
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    },
    fontSizes: {
      display: 100,
      h1: 64,
      h2: 48,
      body: 36,
      caption: 30,
    },
    radius: 10,
    motion: { fadeMs: 360 },
    effects: {
      cardShadow: "0 10px 30px rgba(34, 38, 43, 0.08)",
      innerHighlight: "none",
      hairline: "2px solid rgba(41, 101, 200, 0.35)",
    },
  },
  "blueprint": {
    colors: {
      bg: "#12335e",
      surface: "#174070",
      border: "#2e5c94",
      text: "#dcebff",
      textMuted: "#8fb2dd",
      accent: "#ffd166",
      accent2: "#9ee7ff",
    },
    fonts: {
      display: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      body: SANS_BODY,
      mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    },
    fontSizes: {
      display: 96,
      h1: 62,
      h2: 46,
      body: 36,
      caption: 30,
    },
    radius: 4,
    motion: { fadeMs: 340 },
    effects: {
      cardShadow: "0 18px 44px rgba(6, 24, 48, 0.5)",
      innerHighlight: "none",
      hairline: "1px solid rgba(158, 231, 255, 0.4)",
    },
  },
};

export const DEFAULT_THEME: ThemeName = "glint-dark";

type TokenOverrides = {
  colors?: Partial<DesignTokens["colors"]>;
  fonts?: Partial<DesignTokens["fonts"]>;
  fontSizes?: Partial<DesignTokens["fontSizes"]>;
  radius?: number;
  motion?: Partial<DesignTokens["motion"]>;
  effects?: Partial<DesignTokens["effects"]>;
};

/**
 * Accepts a theme name, inline overrides, or nothing (default theme).
 * Null/garbage input falls back to the default theme so a hand-written
 * SceneScript file can never break rendering; unknown keys are ignored.
 */
export function resolveTheme(
  theme?: string | TokenOverrides | Record<string, unknown> | null,
): DesignTokens {
  if (typeof theme === "string") {
    const named = themes[theme as ThemeName];
    if (!named) {
      throw new Error(
        `Unknown theme "${theme}". Available themes: ${THEME_NAMES.join(", ")}, or pass inline token overrides.`,
      );
    }
    return named;
  }
  const base = themes[DEFAULT_THEME];
  if (!theme || typeof theme !== "object") {
    return base;
  }
  const overrides = theme as TokenOverrides;
  return {
    colors: { ...base.colors, ...overrides.colors },
    fonts: { ...base.fonts, ...overrides.fonts },
    fontSizes: { ...base.fontSizes, ...overrides.fontSizes },
    radius: overrides.radius ?? base.radius,
    motion: { ...base.motion, ...overrides.motion },
    effects: { ...base.effects, ...overrides.effects },
  };
}

const cssVarByPath: Record<string, string> = {
  "colors.bg": "--glint-color-bg",
  "colors.surface": "--glint-color-surface",
  "colors.border": "--glint-color-border",
  "colors.text": "--glint-color-text",
  "colors.textMuted": "--glint-color-text-muted",
  "colors.accent": "--glint-color-accent",
  "colors.accent2": "--glint-color-accent-2",
  "fonts.display": "--glint-font-display",
  "fonts.body": "--glint-font-body",
  "fonts.mono": "--glint-font-mono",
  "fontSizes.display": "--glint-font-size-display",
  "fontSizes.h1": "--glint-font-size-h1",
  "fontSizes.h2": "--glint-font-size-h2",
  "fontSizes.body": "--glint-font-size-body",
  "fontSizes.caption": "--glint-font-size-caption",
  radius: "--glint-radius",
  "motion.fadeMs": "--glint-motion-fade-ms",
  "effects.cardShadow": "--glint-shadow-card",
  "effects.innerHighlight": "--glint-shadow-inner-highlight",
  "effects.hairline": "--glint-line-hairline",
};

function lookupPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Tokens as `--glint-*` custom properties — the single source of truth
 * for variable naming; the CSS-string form derives from this record.
 */
export function tokensToCssVariablesRecord(
  tokens: DesignTokens,
): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  for (const [path, cssVar] of Object.entries(cssVarByPath)) {
    const value = lookupPath(tokens, path);
    if (value === undefined) continue;
    // Unitless numbers are invalid lengths in CSS (`font-size: 96` is
    // ignored by the engine), so length tokens must carry `px`.
    record[cssVar] =
      path === "radius" || path.startsWith("fontSizes.")
        ? `${value}px`
        : (value as string | number);
  }
  return record;
}

/** Renders tokens as `--glint-*` CSS custom properties. */
export function tokensToCssVariables(tokens: DesignTokens): string {
  return Object.entries(tokensToCssVariablesRecord(tokens))
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");
}
type AestheticRecipe = {
  /** Font keys only: sizes come from the rendered theme so the two cannot drift. */
  typography: Omit<StylePackAesthetic["typography"], "scale">;
  composition: StylePackAesthetic["composition"];
  /** Easing/reduced-motion only: entrance timing follows the theme's fadeMs. */
  motion: Omit<StylePackAesthetic["motion"], "entranceMs">;
  pacing: StylePackAesthetic["pacing"];
  sound: StylePackAesthetic["sound"];
  referencePreviews: string[];
};

function stylePack(meta: Omit<StylePackMeta, "aesthetic">, recipe: AestheticRecipe): StylePackMeta {
  const theme = themes[meta.name];
  return {
    ...meta,
    aesthetic: {
      version: 1,
      typography: { ...recipe.typography, scale: { ...theme.fontSizes } },
      composition: recipe.composition,
      motion: { ...recipe.motion, entranceMs: theme.motion.fadeMs },
      pacing: recipe.pacing,
      sound: recipe.sound,
      referencePreviews: [...recipe.referencePreviews],
    },
  };
}

const SANS_NOTE = "CJK 回退系统黑体（PingFang/微软雅黑/Noto Sans SC）；需要可嵌入字体时用 OFL 的思源黑体，不打包字节。";
const SERIF_NOTE = "CJK 回退系统宋体；可嵌入版本用 OFL 的思源宋体，不打包字节。";
const MONO_NOTE = "等宽仅用于标注与数字，不用于整段中文正文。";

/**
 * The 10 style packs: colour plus typography, composition, motion, pacing and
 * sound. Everything here is data we wrote; no font files, brand LUTs or
 * third-party stills are bundled, and no camera-brand simulation is implied.
 */
export const STYLE_PACKS: StylePackMeta[] = [
  stylePack(
    { name: "glint-dark", label: "Glint 深色", category: "studio",
      summary: "深底衬亮字的通用讲解风,适合科技、数据和产品主题。",
      rules: ["保持大面积深底呼吸感,强调色只给关键数字与结论词"] },
    {
      typography: { display: "serif", body: "sans", mono: "mono", notes: `衬线标题+无衬线正文，数字用等宽。${SERIF_NOTE}` },
      composition: { grid: "12 列，内容居中单栏；图表与标题共用一个基线网格", safeArea: "左右各留 8%，上下各留 9%", density: "balanced", notes: "一页一个结论；深底上不要叠超过两层卡片。" },
      motion: { easing: "cubic-bezier(.2,.8,.2,1)", reducedMotion: "只保留 120ms 淡入，取消位移与缩放" },
      pacing: { shotMs: [2800, 6000], holdMs: 600, cutPattern: "结论 → 证据 → 回扣结论" },
      sound: { mood: "克制的电子氛围，低频铺底", targetLufs: -14, duckingDb: 9 },
      referencePreviews: ["深底紫色强调的标题页", "深底单图表页与结论页"],
    },
  ),
  stylePack(
    { name: "glint-light", label: "Glint 浅色", category: "studio",
      summary: "亮底通用讲解风,课程与办公场景友好。",
      rules: ["卡片阴影克制,信息密度高的场景优先用 mint-clean"] },
    {
      typography: { display: "serif", body: "sans", mono: "mono", notes: `亮底使用常规字重，避免过细笔画。${SERIF_NOTE}` },
      composition: { grid: "12 列，左文右图两栏为主", safeArea: "左右各留 8%，上下各留 10%", density: "airy", notes: "留白优先；卡片投影不超过一层。" },
      motion: { easing: "ease-out", reducedMotion: "仅淡入，取消横移" },
      pacing: { shotMs: [2600, 5600], holdMs: 500, cutPattern: "问题 → 解释 → 例子" },
      sound: { mood: "轻钢琴或柔和铺底", targetLufs: -14, duckingDb: 8 },
      referencePreviews: ["白底衬线标题页", "白底要点与图示页"],
    },
  ),
  stylePack(
    { name: "cream-editorial", label: "奶油编辑部", category: "print",
      summary: "米纸底+衬线标题的杂志风,适合人文、商业故事与深度解读。",
      rules: ["标题用衬线,正文行宽不过长;一张页只讲一个论点"] },
    {
      typography: { display: "serif", body: "sans", mono: "mono", notes: `标题用衬线大字，正文行宽控制在 22–28 字。${SERIF_NOTE}` },
      composition: { grid: "单栏 8 列，图文上下错位", safeArea: "左右各留 10%，上下各留 12%", density: "airy", notes: "允许大标题压边；图片可出血但文字不压安全区。" },
      motion: { easing: "cubic-bezier(.33,0,.2,1)", reducedMotion: "只保留淡入与 2% 缩放" },
      pacing: { shotMs: [3200, 7000], holdMs: 900, cutPattern: "场景 → 细节 → 观点" },
      sound: { mood: "原声质感 + 轻弦乐", targetLufs: -14, duckingDb: 10 },
      referencePreviews: ["米纸底衬线大标题页", "引语页与图片出血页"],
    },
  ),
  stylePack(
    { name: "mint-clean", label: "薄荷清爽", category: "studio",
      summary: "浅绿白底的清爽风,适合教程、SaaS 与轻量科普。",
      rules: ["圆角大、留白多,避免超过两层嵌套卡片"] },
    {
      typography: { display: "inter", body: "sans", mono: "mono", notes: `无衬线标题更轻快；拉丁字优先 Inter，中文回退黑体。${SANS_NOTE}` },
      composition: { grid: "12 列，卡片式两列", safeArea: "左右各留 7%，上下各留 8%", density: "airy", notes: "圆角统一，卡片最多两层；图标与文字同基线。" },
      motion: { easing: "ease-out", reducedMotion: "取消弹跳，只淡入" },
      pacing: { shotMs: [2400, 5000], holdMs: 450, cutPattern: "步骤 → 步骤 → 结果" },
      sound: { mood: "明亮木吉他或轻电子", targetLufs: -14, duckingDb: 8 },
      referencePreviews: ["浅绿白卡片步骤页", "两列对比页"],
    },
  ),
  stylePack(
    { name: "bold-poster", label: "海报大字", category: "studio",
      summary: "黑底大字报风,金句、对比和观点型内容最出效果。",
      rules: ["每页大字不超过 12 个字,配图让位给排版"] },
    {
      typography: { display: "inter", body: "sans", mono: "mono", notes: `标题极大、行高极紧；正文只做辅助。${SANS_NOTE}` },
      composition: { grid: "4 列粗网格，标题占 2–3 列", safeArea: "左右各留 6%，上下各留 8%", density: "dense", notes: "每页最多 12 个大字；不允许小字堆信息。" },
      motion: { easing: "cubic-bezier(.16,1,.3,1)", reducedMotion: "取消缩放冲击，保留硬切" },
      pacing: { shotMs: [1800, 3200], holdMs: 400, cutPattern: "金句 → 对照 → 金句" },
      sound: { mood: "重拍打击乐，短促", targetLufs: -13, duckingDb: 11 },
      referencePreviews: ["黑底超大标题页", "两行对照大字页"],
    },
  ),
  stylePack(
    { name: "hand-note", label: "手绘笔记", category: "hand-drawn",
      summary: "米纸底+楷体标注的手账风,像在纸上边讲边画,适合拆解和教程。",
      rules: ["强调色 A/B 各固定给一个核心概念,全片不复用;一次只画一件事"] },
    {
      typography: { display: "kaiti", body: "sans", mono: "mono", notes: `标题用系统楷体；标注可以歪，但不旋转超过 3°。${SANS_NOTE}` },
      composition: { grid: "自由手账布局，以一条横向时间轴串起", safeArea: "左右各留 9%，上下各留 10%", density: "airy", notes: "一次只画一件事；箭头与圈注是主要强调手段。" },
      motion: { easing: "cubic-bezier(.2,.7,.3,1)", reducedMotion: "保留淡入，取消逐笔绘制动画" },
      pacing: { shotMs: [3000, 6500], holdMs: 800, cutPattern: "问题 → 边画边拆 → 小结" },
      sound: { mood: "纸笔摩擦 + 轻节奏", targetLufs: -14, duckingDb: 9 },
      referencePreviews: ["米纸底手写标题页", "逐步画出的流程页"],
    },
  ),
  stylePack(
    { name: "retro-news", label: "复古报刊", category: "print",
      summary: "旧报纸排版:细栏线、衬线、深红强调,适合历史、行业和叙事复盘。",
      rules: ["标题像头版头条;引语用引号+署名;避免现代圆角卡片"] },
    {
      typography: { display: "serif", body: "serif", mono: "mono", notes: `标题与正文都可用衬线，栏线代替卡片。${SERIF_NOTE}` },
      composition: { grid: "多栏报纸网格，栏间细线分隔", safeArea: "左右各留 8%，上下各留 9%", density: "balanced", notes: "引语必须有出处；不要用圆角和投影。" },
      motion: { easing: "linear", reducedMotion: "只做硬切，不做滑动" },
      pacing: { shotMs: [3200, 6800], holdMs: 700, cutPattern: "头条 → 背景 → 影响" },
      sound: { mood: "打字机 + 铜管点缀", targetLufs: -14, duckingDb: 9 },
      referencePreviews: ["头版头条页", "引语与时间线页"],
    },
  ),
  stylePack(
    { name: "blackboard-tech", label: "黑板科技", category: "tech",
      summary: "深黑板底+荧光强调的板书风,公式、架构和工程主题。",
      rules: ["等宽字体做标注;箭头和框线代替实体卡片"] },
    {
      typography: { display: "mono", body: "sans", mono: "mono", notes: `标题与标注用等宽，正文回退黑体。${MONO_NOTE}` },
      composition: { grid: "自由板书，以框线与箭头组织", safeArea: "左右各留 7%，上下各留 9%", density: "balanced", notes: "一块板只讲一个机制；荧光色只标关键路径。" },
      motion: { easing: "steps(6, end)", reducedMotion: "一次性呈现，取消逐笔" },
      pacing: { shotMs: [2800, 6000], holdMs: 650, cutPattern: "机制 → 拆解 → 验证" },
      sound: { mood: "低频脉冲 + 细微颗粒", targetLufs: -14, duckingDb: 10 },
      referencePreviews: ["黑板公式页", "框线架构页"],
    },
  ),
  stylePack(
    { name: "whiteboard", label: "白板马克笔", category: "hand-drawn",
      summary: "白板+马克笔双色标注,机制讲解和流程推演的原生形态。",
      rules: ["蓝红两支马克笔各管一类信息;逐步画出不一次糊满"] },
    {
      typography: { display: "inter", body: "sans", mono: "mono", notes: `标题手写感由字重与倾斜承担，不用装饰字体。${SANS_NOTE}` },
      composition: { grid: "白板分区：左上问题、右侧推演、底部结论", safeArea: "左右各留 8%，上下各留 9%", density: "balanced", notes: "蓝=结构，红=风险/重点；一次只推进一格。" },
      motion: { easing: "cubic-bezier(.25,.8,.25,1)", reducedMotion: "直接呈现整块，不逐笔" },
      pacing: { shotMs: [2600, 5800], holdMs: 600, cutPattern: "问题 → 推演 → 结论" },
      sound: { mood: "干净节拍 + 记号笔声", targetLufs: -14, duckingDb: 9 },
      referencePreviews: ["白板分区推演页", "蓝红双色标注页"],
    },
  ),
  stylePack(
    { name: "blueprint", label: "工程蓝图", category: "tech",
      summary: "深蓝图底+单色线稿的制图风,硬件、建筑感和系统结构。",
      rules: ["单色线稿为主,黄色强调只给关键标注;虚线表辅助信息"] },
    {
      typography: { display: "mono", body: "sans", mono: "mono", notes: `图注与尺寸用等宽；正文保持短句。${MONO_NOTE}` },
      composition: { grid: "制图网格，主图居中、尺寸标注贴边", safeArea: "左右各留 8%，上下各留 10%", density: "balanced", notes: "线稿单色；黄色只标一处关键尺寸或接口。" },
      motion: { easing: "linear", reducedMotion: "只淡入，不移动图层" },
      pacing: { shotMs: [3000, 6500], holdMs: 700, cutPattern: "总图 → 局部 → 接口" },
      sound: { mood: "极简合成器 + 低频", targetLufs: -14, duckingDb: 9 },
      referencePreviews: ["蓝图总装页", "尺寸标注与接口页"],
    },
  ),
];

/** Look up one pack's aesthetic recipe by theme name. */
export function stylePackAesthetic(name: ThemeName): StylePackAesthetic {
  const pack = STYLE_PACKS.find((item) => item.name === name);
  if (!pack) throw new Error(`Unknown style pack: ${name}`);
  return pack.aesthetic;
}
