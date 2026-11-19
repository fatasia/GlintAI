import { STYLE_PACKS, type ThemeName } from "@glintai/design-tokens";

export type StyleTrialReceipt = { version: 1; projectId: string; theme: ThemeName; requestId: string };
const key = (projectId: string) => `glint.style-trial.v1.${encodeURIComponent(projectId)}`;

/** Keep only the lookup token, never the project or a rendered output. */
export function readStyleTrial(projectId: string): StyleTrialReceipt | null {
  const raw = localStorage.getItem(key(projectId));
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (value?.version !== 1 || value.projectId !== projectId || !STYLE_PACKS.some(pack => pack.name === value.theme) || typeof value.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(value.requestId)) throw new Error("试片回执无效");
  return value;
}

export function saveStyleTrial(receipt: StyleTrialReceipt): void {
  localStorage.setItem(key(receipt.projectId), JSON.stringify(receipt));
}

export function removeStyleTrial(projectId: string, requestId: string): void {
  if (readStyleTrial(projectId)?.requestId === requestId) localStorage.removeItem(key(projectId));
}
