import type { CSSProperties } from "react";

/**
 * Shared UI surface tokens: every tool-area component pulls these instead of
 * hand-rolling inline styles. All colors reference the app-theme CSS variables
 * (var(--token, fallback)) so the light/dark toggle flips every panel at once;
 * the fallbacks keep tests and SSR renders visually stable without the sheet.
 */
const palette = {
  bg: "var(--ink-0, #0a0a0b)",
  surface: "var(--ink-2, #121214)",
  border: "var(--line-2, rgba(244,241,234,.12))",
  text: "var(--paper, #f4f1ea)",
  textMuted: "var(--muted, #96928a)",
  accent: "var(--accent, #41649d)",
  /** Accent-hued text: lighter in dark theme so small text stays ≥4.5:1. */
  accentText: "var(--g-accent-text, #93acd8)",
  accentSoft: "var(--g-accent-soft, rgba(74, 110, 168, 0.18))",
  accentLine: "var(--g-accent-line, rgba(120, 152, 210, 0.62))",
  accent2: "var(--warn, #e2b45c)",
};
export const colors = palette;

export const surface: CSSProperties = {
  background: palette.surface,
  border: `1px solid ${palette.border}`,
  borderRadius: 14,
};

export const field: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "9px 12px",
  borderRadius: 9,
  border: `1px solid ${palette.border}`,
  background: "var(--ink-1, #0d0d0f)",
  color: palette.text,
  font: "inherit",
  fontSize: 13,
  boxSizing: "border-box",
  transition: "border-color 140ms ease, box-shadow 140ms ease",
};

export const fieldFocus = {
  outline: "none",
  borderColor: palette.accent,
  boxShadow: `0 0 0 1px var(--accent-soft, rgba(74, 110, 168, 0.33))`,
};

/** Native select skin: same field shape, custom chevron, no browser chrome. */
export const select: CSSProperties = {
  ...field,
  appearance: "none",
  WebkitAppearance: "none",
  paddingRight: 32,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2396928a' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  cursor: "pointer",
};

export const button: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: `1px solid ${palette.border}`,
  borderRadius: 9,
  background: palette.surface,
  color: palette.text,
  padding: "8px 14px",
  font: "inherit",
  fontSize: 12.5,
  cursor: "pointer",
  transition: "border-color 140ms ease, background 140ms ease, transform 100ms ease",
};

export const buttonPrimary: CSSProperties = {
  ...button,
  background: palette.accent,
  borderColor: palette.accent,
  color: "var(--accent-ink, #ffffff)",
  fontWeight: 600,
};

export const buttonGhost: CSSProperties = {
  ...button,
  background: "transparent",
};

export const label: CSSProperties = {
  display: "grid",
  gap: 5,
  fontSize: 11.5,
  color: palette.textMuted,
};

export const heading: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: palette.text,
  letterSpacing: "-0.01em",
};

export const sub: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  lineHeight: 1.65,
  color: palette.textMuted,
};

/** A tool-area card: consistent padding, one radius scale, one border. */
export const card: CSSProperties = {
  display: "grid",
  gap: 14,
  padding: 20,
  ...surface,
};

export const alert: CSSProperties = {
  display: "grid",
  gap: 5,
  padding: "10px 14px",
  borderRadius: 9,
  border: "1px solid var(--warn, #e2b45c)",
  background: "var(--accent-soft, rgba(226, 180, 92, 0.08))",
  color: "var(--warn, #e2b45c)",
  fontSize: 12.5,
  lineHeight: 1.6,
};
