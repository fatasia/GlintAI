import { PrevizDoc, lintPreviz, suggestCamera, type PrevizDocInput, type PrevizIssue } from "@glintai/previz";
import type { Series } from "./drama-series";

/**
 * Deterministic text-to-previs: one drama scene becomes a PrevizDoc whose mannequins, cameras,
 * sizes and timings all come from the shot list. No model is involved, so the same scene always
 * gives the same document, and the document is measured straight away. An AI step can later
 * refine the layout; it starts from something that already passes the geometry rules.
 */

const ACTOR_HEIGHT_M = 1.7;
const STAGE_M = 10;
const SIZE_FOR_CAMERA = { wide: "wide", medium: "medium", close: "close", "over-shoulder": "over-shoulder", insert: "close" } as const;

export interface ScenePrevizResult { doc: PrevizDoc; issues: PrevizIssue[] }

export function previzFromScene(series: Series, sceneId: string): ScenePrevizResult {
  const scene = series.episodes.flatMap(episode => episode.scenes).find(entry => entry.id === sceneId);
  if (!scene) throw new Error(`Unknown scene ${sceneId}`);
  const castIds = [...new Set(scene.shots.flatMap(shot => shot.characterIds))];
  const cast = castIds.map(characterId => series.characters.find(character => character.id === characterId)).filter((c): c is NonNullable<typeof c> => !!c);

  const actors: PrevizDocInput["actors"] = cast.map((character, index) => {
    const [x, z] = placement(index, cast.length);
    const toCentreYaw = (Math.atan2(-x, -z) * 180) / Math.PI;
    return { id: `actor-${character.id}`, name: character.name, characterId: character.id, heightM: ACTOR_HEIGHT_M, position: [x, 0, z], yawDeg: Math.round(toCentreYaw * 100) / 100, pose: "stand" };
  });

  const draft: PrevizDocInput = { schemaVersion: 1, id: `previz-${scene.id}`, title: scene.heading, aspect: series.aspect, fps: 24, stage: { width: STAGE_M, depth: STAGE_M }, props: [], actors, cameras: [], shots: [] };
  const base = PrevizDoc.parse(draft);

  let clock = 0;
  const cameras: PrevizDocInput["cameras"] = [];
  const shots: PrevizDocInput["shots"] = [];
  for (const shot of scene.shots) {
    const subject = shot.characterIds.map(characterId => `actor-${characterId}`).find(id => actors.some(actor => actor.id === id));
    const cameraId = `cam-${shot.id}`;
    if (subject) {
      const suggestion = suggestCamera(base, { actorId: subject, size: SIZE_FOR_CAMERA[shot.size], angleDeg: shot.size === "over-shoulder" ? 25 : 0 });
      cameras.push({ id: cameraId, name: `镜头 ${shot.index}`, fovDeg: suggestion.fovDeg, keys: [{ tMs: 0, position: suggestion.position, target: suggestion.target, easing: "linear" }] });
    } else {
      cameras.push({ id: cameraId, name: `镜头 ${shot.index}`, fovDeg: 50, keys: [{ tMs: 0, position: [0, 2.2, STAGE_M / 2 - 1], target: { point: [0, 1.2, 0] }, easing: "linear" }] });
    }
    shots.push({ id: `pv-${shot.id}`, cameraId, startMs: clock, endMs: clock + shot.durationMs, subjectIds: subject ? [subject] : [], dramaShotId: shot.id, intendedSize: shot.size === "insert" ? undefined : shot.size });
    clock += shot.durationMs;
  }

  const doc = PrevizDoc.parse({ ...draft, cameras, shots });
  return { doc, issues: lintPreviz(doc) };
}

/** Two people face each other 2 m apart; more stand on a 1.5 m circle facing its centre. */
function placement(index: number, count: number): [number, number] {
  if (count === 1) return [0, 0];
  if (count === 2) return [0, index === 0 ? -1 : 1];
  const angle = (2 * Math.PI * index) / count;
  return [Math.round(Math.sin(angle) * 150) / 100, Math.round(Math.cos(angle) * 150) / 100];
}
