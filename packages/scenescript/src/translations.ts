import { z } from "zod";
import type { SceneScriptProject } from "./types";
import { parseProject } from "./parse";

/**
 * Project-level translations (ADR-013.3): per-language text overrides keyed by
 * scene id. The master project stays untouched — a translated project is a
 * deep copy with swapped copy, so every existing export path (SRT, render,
 * timeline) works on it unchanged.
 */

export const SceneTranslation = z.object({
  title: z.string().max(200).optional(),
  heading: z.string().max(200).optional(),
  /** Replaces narration.text (the spoken/subtitled copy). */
  text: z.string().min(1).max(4000).optional(),
  /** Replaces bullets items wholesale. */
  items: z.array(z.string().min(1).max(300)).max(12).optional(),
  subtitle: z.string().max(300).optional(),
});
export type SceneTranslation = z.infer<typeof SceneTranslation>;

export const TranslationTrack = z.object({
  language: z.string().min(2).max(12),
  scenes: z.record(z.string(), SceneTranslation).refine(scenes => Object.keys(scenes).length > 0, "语言轨道至少覆盖一个镜头"),
});
export type TranslationTrack = z.infer<typeof TranslationTrack>;

export const TranslationPack = z.object({
  version: z.literal(1),
  tracks: z.array(TranslationTrack).max(24),
});
export type TranslationPack = z.infer<typeof TranslationPack>;

/** Parse forgivingly: a broken pack never breaks the master project. */
export function parseTranslationPack(value: unknown): TranslationPack {
  const parsed = TranslationPack.safeParse(value);
  return parsed.success ? parsed.data : { version: 1, tracks: [] };
}

export interface TranslationResult {
  project: SceneScriptProject;
  /** Scenes with no override for this language (kept in the master language). */
  untranslated: string[];
}

/** Apply one language track onto a copy of the project. Only declared text
 * fields are replaced; ids, timing and assets stay identical. */
export function applyTranslations(project: SceneScriptProject, pack: TranslationPack, language: string): TranslationResult {
  const track = pack.tracks.find(item => item.language === language);
  if (!track) return { project, untranslated: project.scenes.map(scene => scene.id) };
  const translated = structuredClone(project);
  const untranslated: string[] = [];
  for (const scene of translated.scenes) {
    const override = track.scenes[scene.id];
    if (!override) { untranslated.push(scene.id); continue; }
    if (override.title !== undefined && "title" in scene) (scene as { title?: string }).title = override.title;
    if (override.heading !== undefined && "heading" in scene) (scene as { heading?: string }).heading = override.heading;
    if (override.subtitle !== undefined && "subtitle" in scene) (scene as { subtitle?: string }).subtitle = override.subtitle;
    if (override.text !== undefined) scene.narration = { ...scene.narration, text: override.text };
    if (override.items !== undefined && "items" in scene) (scene as { items?: string[] }).items = [...override.items];
  }
  return { project: parseProject(translated), untranslated };
}

/** Coverage per language: which scene ids lack overrides. */
export function translationCoverage(project: SceneScriptProject, pack: TranslationPack): Array<{ language: string; missing: string[] }> {
  const ids = project.scenes.map(scene => scene.id);
  return pack.tracks.map(track => ({ language: track.language, missing: ids.filter(id => !track.scenes[id]) }));
}
