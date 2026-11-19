import { setShotEngine, type MgKind, type Series, type ShotEngine } from "@glintai/composer/drama-series";

/**
 * What the storyboard keeps of its own: the series' default render engine and the shots the user switched.
 * Everything else (shots, looks, issues, quotes) is derived from the screenplay and the project's assets.
 * Overrides are keyed by scene fingerprint + shot number, so they survive edits elsewhere in the script.
 */
export interface StoryboardPrefs {
  version: 1;
  defaultEngine?: ShotEngine;
  overrides: Record<string, { engine: ShotEngine; mgKind?: MgKind }>;
}

export const storyboardPrefsKey = (projectId: string) => `glint.storyboard.v1:${projectId}`;
export const shotKey = (fingerprint: string, index: number, sceneId?: string) => `${sceneId ? `${sceneId}:` : ""}${fingerprint}:${index}`;
const MAX_OVERRIDES = 5000;
const ENGINES = new Set(["mg", "aigc"]);
const MG_KINDS = new Set(["title", "bullets", "definition", "quote", "comparison", "code", "diagram", "chart", "html", "three"]);

export const emptyPrefs = (): StoryboardPrefs => ({ version: 1, overrides: {} });

/** Reads leniently: damaged or foreign data gives empty preferences rather than blocking the workspace. */
export function readStoryboardPrefs(projectId: string, storage: Pick<Storage, "getItem"> = localStorage): StoryboardPrefs {
  try {
    const raw = storage.getItem(storyboardPrefsKey(projectId));
    if (!raw || raw.length > 1_000_000) return emptyPrefs();
    const value = JSON.parse(raw) as Partial<StoryboardPrefs> | null;
    if (!value || value.version !== 1 || typeof value.overrides !== "object" || value.overrides === null) return emptyPrefs();
    const overrides: StoryboardPrefs["overrides"] = {};
    for (const [key, entry] of Object.entries(value.overrides).slice(0, MAX_OVERRIDES)) {
      if (!/^(?:ep-\d+-sc-\d+:)?[0-9a-f]{8}:\d{1,4}$/.test(key) || !entry || !ENGINES.has(entry.engine)) continue;
      overrides[key] = entry.engine === "mg" && entry.mgKind && MG_KINDS.has(entry.mgKind) ? { engine: "mg", mgKind: entry.mgKind } : { engine: entry.engine };
    }
    return { version: 1, defaultEngine: value.defaultEngine && ENGINES.has(value.defaultEngine) ? value.defaultEngine : undefined, overrides };
  } catch { return emptyPrefs(); }
}

export function writeStoryboardPrefs(projectId: string, prefs: StoryboardPrefs, storage: Pick<Storage, "setItem"> = localStorage): boolean {
  try { storage.setItem(storyboardPrefsKey(projectId), JSON.stringify(prefs)); return true; } catch { return false; }
}

/** Applies the saved per-shot choices on top of a series built with the default engine. */
export function applyEngineOverrides(series: Series, overrides: StoryboardPrefs["overrides"]): Series {
  let next = series;
  const fingerprints = series.episodes.flatMap(episode => episode.scenes.map(scene => scene.fingerprint));
  for (const episode of series.episodes) for (const scene of episode.scenes) for (const shot of scene.shots) {
    const choice = overrides[shotKey(scene.fingerprint, shot.index, scene.id)] ?? (fingerprints.filter(value => value === scene.fingerprint).length === 1 ? overrides[shotKey(scene.fingerprint, shot.index)] : undefined);
    if (choice && (choice.engine !== shot.engine || (choice.engine === "mg" && choice.mgKind && choice.mgKind !== shot.mgKind))) next = setShotEngine(next, shot.id, choice.engine, choice.mgKind);
  }
  return next;
}
