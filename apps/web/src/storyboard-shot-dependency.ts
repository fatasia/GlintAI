import { canonicalJson } from "@glintai/session";
import type { Series } from "@glintai/composer/drama-series";
import { storyboardVideoPrompt, type StoryboardShot } from "./storyboard-project";
/** Bind recovery to the current look/reference/approval snapshot, not just the shot's stable ID. */
export function storyboardGenerationInput(series: Series, row: StoryboardShot) {
  return {
    version: 1,
    shotId: row.id,
    prompt: storyboardVideoPrompt(row),
    durationMs: row.shot.durationMs,
    engine: row.shot.engine,
    characters: row.shot.characterIds.map((id) => {
      const character = series.characters.find((item) => item.id === id);
      return { id, looks: character?.looks ?? [], voice: character?.voice ?? null };
    }),
    location: series.locations.find((item) => item.id === row.shot.locationId) ?? null,
  };
}
export async function storyboardDependencyDigest(
  input: ReturnType<typeof storyboardGenerationInput>,
): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("storyboard.digestUnavailable");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input)),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
