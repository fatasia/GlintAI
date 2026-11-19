import { parseProject, type Scene, type SceneScriptProject } from "@glintai/scenescript";
import {
  setShotEngine,
  type MgKind,
  type Series,
  type Shot,
  type SeriesScene,
} from "@glintai/composer/drama-series";
import { libraryVisual } from "./media-adoption";
import { parseEditorProject } from "./editor-model";
import { t } from "./ui/i18n";

function hash(text: string): string {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return (value >>> 0).toString(16).padStart(8, "0");
}
export interface StoryboardShot {
  id: string;
  shot: Shot;
  scene: SeriesScene;
}

/** Only recover a complete applied draft; new shots still need an explicit choice. */
export function hasAppliedStoryboard(
  series: Series,
  project: SceneScriptProject,
  documentId: string,
): boolean {
  const ids = new Set(project.scenes.map((scene) => scene.id));
  const rows = series.episodes.flatMap((episode) =>
    storyboardShots(series, episode.id, documentId),
  );
  return rows.length > 0 && rows.every((row) => ids.has(row.id));
}

/** Ids survive unrelated scene insertions, but identical repeated scenes remain distinct. */
export function storyboardShots(
  series: Series,
  episodeId: string,
  documentId: string,
): StoryboardShot[] {
  const episode = series.episodes.find((item) => item.id === episodeId);
  if (!episode) throw new Error(t("storyboard.invalidEpisode"));
  const seen = new Map<string, number>();
  for (const earlier of series.episodes) {
    if (earlier.id === episodeId) break;
    for (const scene of earlier.scenes)
      seen.set(scene.fingerprint, (seen.get(scene.fingerprint) ?? 0) + 1);
  }
  return episode.scenes.flatMap((scene) => {
    const occurrence = seen.get(scene.fingerprint) ?? 0;
    seen.set(scene.fingerprint, occurrence + 1);
    return scene.shots.map((shot) => ({
      id: `board-${hash(documentId)}-${scene.fingerprint}-${occurrence}-${shot.index}`,
      shot,
      scene,
    }));
  });
}

function motionContent(row: StoryboardShot, series: Series): Record<string, unknown> {
  const { shot, scene } = row,
    kind = shot.mgKind ?? "title";
  const text = shot.dialogue.map((line) => line.line).join("\n") || shot.action || scene.heading;
  if (kind === "title") return { kind, title: text };
  if (kind === "quote")
    return {
      kind,
      text,
      attribution: shot.dialogue
        .map(
          (line) =>
            series.characters.find((character) => character.id === line.characterId)?.name ?? "",
        )
        .filter(Boolean)
        .join("、"),
    };
  if (kind === "bullets")
    return { kind, heading: scene.heading, items: text.split(/[。！？\n]+/).filter(Boolean) };
  if (kind === "definition") return { kind, term: scene.heading, definition: text };
  if (kind === "code") return { kind, code: text, language: "text" };
  if (kind === "diagram") {
    const steps = text
      .split(/[。！？\n]+/)
      .filter(Boolean)
      .map((label) => ({ label }));
    if (steps.length >= 2 && steps.length <= 5) return { kind, heading: scene.heading, steps };
  }
  throw new Error(t("storyboard.needsData", { kind }));
}

function materialize(
  row: StoryboardShot,
  series: Series,
  project: SceneScriptProject,
  media: Readonly<Record<string, string>>,
): Scene {
  const previous = project.scenes.find((scene) => scene.id === row.id),
    kind = row.shot.mgKind ?? "title";
  if (row.shot.engine === "mg" && previous && previous.kind === kind)
    return structuredClone(previous);
  const text =
    row.shot.dialogue.map((line) => line.line).join("\n") || row.shot.action || row.scene.heading;
  const base = {
    id: row.id,
    narration: previous?.narration ?? { text, durationMs: row.shot.durationMs },
    ...(previous?.elements ? { elements: previous.elements } : {}),
    ...(previous?.tracks ? { tracks: previous.tracks } : {}),
    ...(previous?.effects ? { effects: previous.effects } : {}),
    ...(previous?.transition ? { transition: previous.transition } : {}),
    ...(previous?.camera ? { camera: previous.camera } : {}),
    ...(previous?.assetRefs ? { assetRefs: previous.assetRefs } : {}),
    ...(previous?.sharedElements ? { sharedElements: previous.sharedElements } : {}),
    ...(previous?.notes ? { notes: previous.notes } : {}),
  };
  if (row.shot.engine === "mg") return { ...base, ...motionContent(row, series) } as Scene;
  const name =
    media[row.id] ??
    (previous && (previous.kind === "video" || previous.kind === "image")
      ? previous.src.slice("assets/".length)
      : "");
  if (!name) throw new Error(t("storyboard.missingMedia", { shot: row.shot.index }));
  const asset = libraryVisual(name);
  if (
    previous &&
    (previous.kind === "video" || previous.kind === "image") &&
    previous.src === `assets/${name}`
  )
    return structuredClone(previous);
  if (previous && previous.kind === asset.kind)
    return { ...structuredClone(previous), src: `assets/${asset.name}` };
  return { ...base, kind: asset.kind, src: `assets/${asset.name}` };
}

/** Replace only an already-applied shot. Other scenes and project audio remain byte-equivalent. */
export function applyStoryboardShot(
  project: SceneScriptProject,
  series: Series,
  episodeId: string,
  documentId: string,
  shotId: string,
  media: Readonly<Record<string, string>>,
): SceneScriptProject {
  const input = parseProject(project),
    row = storyboardShots(series, episodeId, documentId).find((item) => item.id === shotId);
  const before = input.scenes.find((scene) => scene.id === shotId);
  if (!row || !before) throw new Error(t("storyboard.notApplied"));
  if (input.frozen || before.locked) throw new Error(t("storyboard.locked"));
  const replacement = materialize(row, series, input, media);
  return parseProject({
    ...input,
    scenes: input.scenes.map((scene) => (scene.id === shotId ? replacement : scene)),
  });
}

export function storyboardVideoPrompt(row: StoryboardShot): string {
  return (
    row.shot.videoPrompt.trim() ||
    [row.scene.heading, row.shot.action, ...row.shot.dialogue.map((line) => line.line)]
      .filter(Boolean)
      .join("\n")
  );
}

/** Pure conversion; the caller applies the entire result through the existing session transaction. */
export function applyStoryboard(
  project: SceneScriptProject,
  series: Series,
  episodeId: string,
  documentId: string,
  media: Readonly<Record<string, string>>,
): SceneScriptProject {
  const input = parseProject(project),
    rows = storyboardShots(series, episodeId, documentId);
  if (input.frozen || input.scenes.some((scene) => scene.locked))
    throw new Error(t("storyboard.locked"));
  if (!rows.length || rows.length > 30) throw new Error(t("storyboard.tooMany"));
  const scenes = rows.map((row) => materialize(row, series, input, media));
  return parseEditorProject({ ...input, scenes });
}

/** The saved project, not a browser preference, records how applied shots actually render. */
export function projectStoryboardChoices(
  series: Series,
  project: SceneScriptProject,
  documentId: string,
): Series {
  let next = series;
  for (const episode of series.episodes)
    for (const row of storyboardShots(series, episode.id, documentId)) {
      const scene = project.scenes.find((item) => item.id === row.id);
      if (!scene) continue;
      next = setShotEngine(
        next,
        row.shot.id,
        scene.kind === "video" || scene.kind === "image" ? "aigc" : "mg",
        scene.kind === "video" || scene.kind === "image" ? undefined : (scene.kind as MgKind),
      );
    }
  return next;
}
