import { z } from "zod";

/**
 * Story canon (ADR-013.2): a project-level table of characters, locations,
 * props and facts. Generation injects a compact brief; the lint pass keeps
 * naming consistent — deterministic checks only, no semantic guessing.
 */

export const CanonEntry = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["character", "location", "prop", "fact"]),
  /** The one canonical name every scene must use. */
  name: z.string().min(1).max(80),
  /** Additional accepted spellings; anything else is flagged. */
  aliases: z.array(z.string().min(1).max(80)).max(16).default([]),
  /** Known-name variants that must NOT appear (legacy/wrong spellings). */
  forbidden: z.array(z.string().min(1).max(80)).max(16).default([]),
  facts: z.array(z.string().min(1).max(300)).max(24).default([]),
});
export type CanonEntry = z.infer<typeof CanonEntry>;

export const CanonTable = z.object({
  version: z.literal(1),
  entries: z.array(CanonEntry).max(200).default([]),
});
export type CanonTable = z.infer<typeof CanonTable>;

/** Parse forgivingly: a corrupt or partial canon table degrades to empty. */
export function parseCanonTable(value: unknown): CanonTable {
  const parsed = CanonTable.safeParse(value);
  return parsed.success ? parsed.data : { version: 1, entries: [] };
}

/** Compact block for the compose system prompt: names, aliases and facts. */
export function canonBrief(table: CanonTable): string {
  if (!table.entries.length) return "";
  return table.entries.map(entry => {
    const aliases = entry.aliases.length ? `（又称 ${entry.aliases.join("、")}）` : "";
    const facts = entry.facts.length ? `：${entry.facts.join("；")}` : "";
    return `- ${entry.name}${aliases}${facts}`;
  }).join("\n");
}

export interface CanonIssue {
  kind: "forbidden-name" | "duplicate-name";
  sceneId?: string;
  detail: string;
}

/** Deterministic consistency lint over scene text: forbidden legacy names are
 * flagged per scene, and two canon entries may not claim the same name. */
export function canonLint(table: CanonTable, scenes: ReadonlyArray<{ id: string; text: string }>): CanonIssue[] {
  const issues: CanonIssue[] = [];
  const seen = new Map<string, string>();
  for (const entry of table.entries) {
    const names = [entry.name, ...entry.aliases];
    for (const name of names) {
      const previous = seen.get(name);
      if (previous && previous !== entry.id) issues.push({ kind: "duplicate-name", detail: `「${name}」同时属于 ${previous} 和 ${entry.id}` });
      seen.set(name, entry.id);
    }
  }
  for (const scene of scenes) {
    for (const entry of table.entries) {
      for (const wrong of entry.forbidden) {
        if (scene.text.includes(wrong)) {
          issues.push({ kind: "forbidden-name", sceneId: scene.id, detail: `镜头 "${scene.id}" 用了禁用名「${wrong}」，应写作「${entry.name}」` });
        }
      }
    }
  }
  return issues;
}

/** Canon entries that never appear in any scene text — dead table rows. */
export function unusedCanonEntries(table: CanonTable, scenes: ReadonlyArray<{ id: string; text: string }>): string[] {
  const all = scenes.map(scene => scene.text).join("\n");
  return table.entries.filter(entry => !entry.aliases.some(alias => all.includes(alias)) && !all.includes(entry.name)).map(entry => entry.id);
}
