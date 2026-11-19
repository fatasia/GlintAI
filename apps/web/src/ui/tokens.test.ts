import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Verifies the contrast promises in docs/design/DESIGN-LANGUAGE.md §2 against the real token file,
// in both themes. Colors are read from tokens.css so a palette edit cannot silently break them.
const css = fs.readFileSync(path.resolve(__dirname, "tokens.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing ${selector} in tokens.css`);
  const open = css.indexOf("{", start), close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}
const themes = { dark: block(":root {"), light: block(':root[data-theme="light"] {') };

type Rgb = [number, number, number];
function token(theme: keyof typeof themes, name: string): Rgb {
  const own = themes[theme].match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  const value = own?.[1] ?? themes.dark.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`))?.[1];
  if (!value) throw new Error(`Token ${name} has no hex value in ${theme}`);
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as Rgb;
}
const lum = ([r, g, b]: Rgb) => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const AA = 4.5, LARGE_OR_UI = 3;

describe.each(["dark", "light"] as const)("%s theme contrast", theme => {
  const t = (name: string) => token(theme, name);
  const surfaces = ["--g-bg-0", "--g-bg-1", "--g-bg-2", "--g-bg-3"];

  it.each(surfaces)("body and secondary text meet AA on %s", surface => {
    expect(ratio(t("--g-fg-1"), t(surface))).toBeGreaterThanOrEqual(AA);
    expect(ratio(t("--g-fg-2"), t(surface))).toBeGreaterThanOrEqual(AA);
  });

  it.each(surfaces)("tertiary text (labels, meta) meets AA on %s", surface => {
    expect(ratio(t("--g-fg-3"), t(surface))).toBeGreaterThanOrEqual(AA);
  });

  it.each(surfaces)("accent-hued text meets AA on %s", surface => {
    expect(ratio(t("--g-accent-text"), t(surface))).toBeGreaterThanOrEqual(AA);
  });

  it("the primary action keeps AA text and a distinct fill in every state", () => {
    for (const fill of ["--g-accent", "--g-accent-hover", "--g-accent-press"]) {
      expect(ratio(t("--g-on-accent"), t(fill))).toBeGreaterThanOrEqual(AA);
    }
    // The fill must be visible as a shape against the panel it sits on (UI component, 3:1).
    expect(ratio(t("--g-accent"), t("--g-bg-1"))).toBeGreaterThanOrEqual(LARGE_OR_UI);
  });

  it.each(["--g-ok", "--g-warn", "--g-danger"])("semantic text %s meets AA on the panel", name => {
    expect(ratio(t(name), t("--g-bg-1"))).toBeGreaterThanOrEqual(AA);
    expect(ratio(t(name), t("--g-bg-2"))).toBeGreaterThanOrEqual(AA);
  });

  it("each surface step is distinguishable from the next", () => {
    for (let i = 0; i < surfaces.length - 1; i++) {
      expect(ratio(t(surfaces[i]!), t(surfaces[i + 1]!))).toBeGreaterThan(1.02);
    }
  });

  it("timeline track colors are mutually distinguishable and never equal the accent", () => {
    const tracks = ["scene", "video", "image", "voice", "music", "sfx", "caption"].map(name => `--g-track-${name}`);
    for (const name of tracks) expect(ratio(t(name), t("--g-accent"))).toBeGreaterThan(1.05);
    // Same-hue neighbors are allowed to be close, but no two tracks may be identical.
    expect(new Set(tracks.map(name => t(name).join(","))).size).toBe(tracks.length);
  });
});

describe("token file integrity", () => {
  it("defines the same --g-* color names in both themes (light overrides are a subset of dark)", () => {
    const names = (text: string) => new Set([...text.matchAll(/(--g-(?:bg|fg|line|accent|on-accent|ok|warn|danger|shadow|overlay|focus)[\w-]*):/g)].map(match => match[1]));
    const dark = names(themes.dark), light = names(themes.light);
    for (const name of light) expect(dark.has(name), `${name} overrides a token that dark does not define`).toBe(true);
    // Every color token a component can read must resolve in light mode too (own value or inherited).
    expect(dark.size).toBeGreaterThanOrEqual(30);
  });

  it("declares the documented type, spacing and layer scales", () => {
    for (let i = 1; i <= 8; i++) expect(css).toMatch(new RegExp(`--g-fs-${i}:`));
    for (const layer of ["base", "sticky", "dock", "popover", "dialog", "toast"]) expect(css).toMatch(new RegExp(`--g-z-${layer}:`));
    for (const name of ["--g-dur-1", "--g-dur-2", "--g-dur-3", "--g-ease", "--g-ease-drawer"]) expect(css).toContain(name);
  });
});
