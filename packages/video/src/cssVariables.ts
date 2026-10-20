import type { CSSProperties } from "react";
import {
  tokensToCssVariablesRecord,
  type DesignTokens,
} from "@glintai/design-tokens";

export function cssVariablesStyle(tokens: DesignTokens): CSSProperties {
  return tokensToCssVariablesRecord(tokens) as CSSProperties;
}
