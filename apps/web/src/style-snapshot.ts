import { themes, type DesignTokens, type ThemeName } from "@glintai/design-tokens";
import { canonicalJson } from "@glintai/session";

/** Version identifies the snapshot format, not the renderer, font bytes or catalog recipe. */
export const STYLE_TOKEN_VERSION = "1.0.0";
export interface StyleSnapshot { name: ThemeName; version: string; captured: DesignTokens }

// The v1 shape must not depend on today's catalog: old snapshots survive added tokens.
const V1_FIELDS = {
  colors: ["bg", "surface", "border", "text", "textMuted", "accent", "accent2"],
  fonts: ["display", "body", "mono"],
  fontSizes: ["display", "h1", "h2", "body", "caption"],
  motion: ["fadeMs"],
  effects: ["cardShadow", "innerHighlight", "hairline"],
} as const;

function validV1Tokens(value: unknown): value is DesignTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tokens = value as Record<string, unknown>;
  if (typeof tokens.radius !== "number" || !Number.isFinite(tokens.radius)) return false;
  return Object.entries(V1_FIELDS).every(([section, fields]) => {
    const group = tokens[section];
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    return fields.every(field => {
      const entry = (group as Record<string, unknown>)[field];
      return section === "fontSizes" || section === "motion"
        ? typeof entry === "number" && Number.isFinite(entry)
        : typeof entry === "string";
    });
  });
}

export function captureStyleTokens(name: ThemeName): Record<string, unknown> {
  const tokens = structuredClone(themes[name]);
  return { ...tokens, glintStyleSnapshot: { name, version: STYLE_TOKEN_VERSION, captured: structuredClone(tokens) } };
}

/** Only the supported format is interpreted; unknown metadata stays untouched in the project. */
export function readStyleSnapshot(value: unknown): (StyleSnapshot & { modified: boolean }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const info = (value as Record<string, unknown>).glintStyleSnapshot;
  if (!info || typeof info !== "object" || Array.isArray(info)) return;
  const { name, version, captured } = info as Record<string, unknown>;
  if (typeof name !== "string" || !Object.hasOwn(themes, name) || version !== STYLE_TOKEN_VERSION || !validV1Tokens(captured)) return;
  const current = value as Record<string, unknown>;
  const projectV1 = (tokens: Record<string, unknown>) => ({
    radius: tokens.radius,
    ...Object.fromEntries(Object.entries(V1_FIELDS).map(([section, fields]) => [section,
      Object.fromEntries(fields.map(field => [field, (tokens[section] as Record<string, unknown>)[field]])),
    ])),
  });
  return {
    name: name as ThemeName, version, captured,
    modified: !validV1Tokens(current) || canonicalJson(projectV1(current)) !== canonicalJson(projectV1(captured as unknown as Record<string, unknown>)),
  };
}
