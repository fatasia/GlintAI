export type ThemeName =
  | "glint-dark"
  | "glint-light"
  | "cream-editorial"
  | "mint-clean"
  | "bold-poster";

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

export const THEME_NAMES = ["glint-dark", "glint-light", "cream-editorial", "mint-clean", "bold-poster"] as const;

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
