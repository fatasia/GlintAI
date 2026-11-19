import { z } from "zod";
import { checkBudget, quote, type BudgetCheck, type BudgetLine, type ModelRegistry } from "@glintai/models";
import type { AssetIdentity } from "@glintai/scenescript";
import { splitScreenplay, type DramaScene } from "./drama";

/**
 * Short-drama domain model (series → episode → scene → shot) with the pure logic around it:
 * screenplay import that keeps approved looks on re-import, a deterministic shot list,
 * consistent prompts, continuity checks and a cost quote. No model is called here;
 * generation steps read these structures and write assets back by id.
 */

export const SERIES_VERSION = 1;

const id = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const assetId = z.string().min(1).max(120);

export const Look = z.object({
  id,
  name: z.string().min(1).max(60),
  /** The words that fix this look in every shot: clothes, hair, age, signature props. */
  prompt: z.string().max(600),
  referenceAssetIds: z.array(assetId).max(8),
  approved: z.boolean(),
});
export const Voice = z.object({ engine: z.string().min(1).max(40), voiceId: z.string().max(80).optional(), style: z.string().max(120).optional() });
export const Character = z.object({
  id,
  name: z.string().min(1).max(40),
  aliases: z.array(z.string().min(1).max(40)).max(10),
  description: z.string().max(800),
  looks: z.array(Look).min(1).max(12),
  voice: Voice.optional(),
});
export const Location = z.object({
  id,
  name: z.string().min(1).max(80),
  interior: z.boolean(),
  prompt: z.string().max(600),
  referenceAssetIds: z.array(assetId).max(8),
});

export const ShotSize = z.enum(["wide", "medium", "close", "over-shoulder", "insert"]);
export const CameraMove = z.enum(["static", "push-in", "pull-out", "pan", "tilt", "handheld"]);
export const ShotStatus = z.enum(["draft", "image-ready", "video-ready", "approved", "needs-redo"]);
export type ShotSize = z.infer<typeof ShotSize>;
export type CameraMove = z.infer<typeof CameraMove>;

export const MIN_SHOT_MS = 1000;
export const MAX_SHOT_MS = 15000;

/**
 * How a shot is rendered. MG (motion graphics: Glint's own deterministic scenes) and AIGC (image and video
 * models) are equal choices; neither is a fallback for the other and a series may mix them freely.
 */
export const ShotEngine = z.enum(["aigc", "mg"]);
export type ShotEngine = z.infer<typeof ShotEngine>;
/** The SceneScript scene kinds that are rendered by Glint itself. */
export const MgKind = z.enum(["title", "bullets", "definition", "quote", "comparison", "code", "diagram", "chart", "html", "three"]);
export type MgKind = z.infer<typeof MgKind>;

export const Shot = z.object({
  id,
  index: z.number().int().min(1),
  engine: ShotEngine,
  /** For an `mg` shot: which built-in scene renders it. */
  mgKind: MgKind.optional(),
  size: ShotSize,
  move: CameraMove,
  durationMs: z.number().int().min(MIN_SHOT_MS).max(MAX_SHOT_MS),
  action: z.string().max(1000),
  dialogue: z.array(z.object({ characterId: id, line: z.string().min(1).max(600) })).max(6),
  characterIds: z.array(id).max(8),
  /** characterId → look used in this shot; absent means the character's first approved look, else the first look. */
  lookIds: z.record(z.string(), z.string()).optional(),
  locationId: id,
  imagePrompt: z.string().max(3000),
  videoPrompt: z.string().max(3000),
  firstFrameAssetId: assetId.optional(),
  videoAssetId: assetId.optional(),
  status: ShotStatus,
});
export const SeriesScene = z.object({
  id,
  heading: z.string().min(1).max(300),
  locationId: id,
  timeOfDay: z.string().max(20),
  /** Change detector for re-import: same fingerprint means the source text did not change. */
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  shots: z.array(Shot).max(300),
});
export const SeriesEpisode = z.object({ id, index: z.number().int().min(1), title: z.string().min(1).max(200), scenes: z.array(SeriesScene).min(1).max(200) });

export const Series = z.object({
  schemaVersion: z.literal(SERIES_VERSION),
  id,
  title: z.string().min(1).max(200),
  aspect: z.enum(["16:9", "9:16", "1:1"]),
  /** What new shots use until the user changes them; chosen by the user, never assumed. */
  defaultEngine: ShotEngine,
  style: z.object({ name: z.string().max(60), prompt: z.string().max(600) }),
  characters: z.array(Character).max(60),
  locations: z.array(Location).max(120),
  episodes: z.array(SeriesEpisode).min(1).max(200),
});
export type Look = z.infer<typeof Look>;
export type Character = z.infer<typeof Character>;
export type Location = z.infer<typeof Location>;
export type Shot = z.infer<typeof Shot>;
export type SeriesScene = z.infer<typeof SeriesScene>;
export type SeriesEpisode = z.infer<typeof SeriesEpisode>;
export type Series = z.infer<typeof Series>;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const CHARS_PER_SECOND = 3.5;
const LONG_LINE = 24;
const MAX_CHUNK = 40;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

type Beat = NonNullable<DramaScene["beats"]>[number];

function beatsOf(scene: DramaScene): Beat[] {
  if (scene.beats?.length) return scene.beats;
  return [...(scene.action ? [{ kind: "action" as const, text: scene.action }] : []), ...scene.dialogue.map(line => ({ kind: "dialogue" as const, ...line }))];
}

export function sceneFingerprint(scene: DramaScene): string {
  return fnv1a(JSON.stringify([scene.heading, scene.location, scene.timeOfDay, beatsOf(scene)]));
}

/** Splits at sentence punctuation so no chunk is longer than `max`; very long unpunctuated text is cut hard. */
function chunkText(text: string, max: number, merge = true): string[] {
  const sentences = text.split(/(?<=[。！？!?；;…])/u).map(part => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      const last = out[out.length - 1];
      if (merge && last !== undefined && last.length + sentence.length <= max) out[out.length - 1] = last + sentence; else out.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
  }
  return out;
}

interface Seed { characters: readonly Character[]; locations: readonly Location[] }

function matchCharacter(seed: readonly Character[], name: string): Character | undefined {
  return seed.find(character => character.name === name || character.aliases.includes(name));
}

export interface BuildOptions {
  /** How new shots are rendered. The user picks it; mixing is done per shot afterwards. */
  engine: ShotEngine;
  id?: string;
  title?: string;
  aspect?: Series["aspect"];
  style?: Series["style"];
  episodeSize?: number;
  /** Existing characters and locations whose ids, looks and voices must survive a re-import. */
  seed?: Seed;
}

export class ScreenplayError extends Error {
  constructor(message: string, readonly issues: string[]) { super(message); this.name = "ScreenplayError"; }
}

function nextId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  const next = `${prefix}-${n}`;
  used.add(next);
  return next;
}

export function buildSeries(text: string, options: BuildOptions): Series {
  const split = splitScreenplay(text, { episodeSize: options.episodeSize });
  if (!split.episodes.length) throw new ScreenplayError("剧本里没有识别到场景标题", split.issues);
  const seed = options.seed ?? { characters: [], locations: [] };
  const usedChars = new Set(seed.characters.map(character => character.id));
  const usedLocs = new Set(seed.locations.map(location => location.id));

  const characters: Character[] = [];
  for (const entry of split.characters) {
    const known = matchCharacter(seed.characters, entry.name);
    if (known) { if (!characters.some(character => character.id === known.id)) characters.push(known); continue; }
    const charId = nextId("char", usedChars);
    characters.push({ id: charId, name: entry.name, aliases: [], description: "", looks: [{ id: `${charId}-look-1`, name: "默认造型", prompt: "", referenceAssetIds: [], approved: false }] });
  }
  const locations: Location[] = [];
  const locationFor = (name: string, interior: boolean): Location => {
    const existing = locations.find(location => location.name === name);
    if (existing) return existing;
    const known = seed.locations.find(location => location.name === name);
    const location: Location = known ?? { id: nextId("loc", usedLocs), name, interior, prompt: "", referenceAssetIds: [] };
    locations.push(location);
    return location;
  };
  const characterByName = (name: string) => characters.find(character => character.name === name || character.aliases.includes(name));

  const episodes: SeriesEpisode[] = split.episodes.map(episode => ({
    id: `ep-${episode.index}`,
    index: episode.index,
    title: episode.title,
    scenes: episode.scenes.map((scene, sceneIndex) => {
      const sceneId = `ep-${episode.index}-sc-${sceneIndex + 1}`;
      const location = locationFor(scene.location, scene.interior);
      return { id: sceneId, heading: scene.heading, locationId: location.id, timeOfDay: scene.timeOfDay, fingerprint: sceneFingerprint(scene), shots: planShots(scene, sceneId, location.id, characterByName, options.engine) };
    }),
  }));

  return refreshPrompts({
    schemaVersion: SERIES_VERSION,
    id: options.id ?? "series-1",
    title: options.title ?? "未命名短剧",
    aspect: options.aspect ?? "9:16",
    defaultEngine: options.engine,
    style: options.style ?? { name: "", prompt: "" },
    characters,
    locations,
    episodes,
  });
}

function planShots(scene: DramaScene, sceneId: string, locationId: string, characterByName: (name: string) => Character | undefined, engine: ShotEngine): Shot[] {
  const shots: Shot[] = [];
  const add = (shot: Omit<Shot, "id" | "index" | "engine" | "mgKind" | "locationId" | "imagePrompt" | "videoPrompt" | "status">) => {
    const index = shots.length + 1;
    shots.push({ ...shot, id: `${sceneId}-sh-${index}`, index, engine, ...(engine === "mg" ? { mgKind: defaultMgKind(shot) } : {}), locationId, imagePrompt: "", videoPrompt: "", status: "draft" });
  };
  const beats = beatsOf(scene);
  const firstAction = beats.find((beat): beat is Extract<Beat, { kind: "action" }> => beat.kind === "action");
  const firstSentence = firstAction ? chunkText(firstAction.text, 80, false)[0] : undefined;
  add({ size: "wide", move: "push-in", durationMs: 3000, action: firstSentence ?? `${scene.interior ? "内景" : "外景"}${scene.location}${scene.timeOfDay ? `，${scene.timeOfDay}` : ""}`, dialogue: [], characterIds: [] });

  let usedOpening = false;
  let previousSpeaker: string | undefined;
  for (const beat of beats) {
    if (beat.kind === "action") {
      for (const [i, sentence] of chunkText(beat.text, 80, false).entries()) {
        if (!usedOpening && beat === firstAction && i === 0) { usedOpening = true; continue; }
        const present = [...new Set(scene.characters.map(name => characterByName(name)).filter((c): c is Character => !!c && (sentence.includes(c.name) || c.aliases.some(alias => sentence.includes(alias)))).map(c => c.id))];
        add({ size: present.length ? "medium" : "insert", move: "static", durationMs: clamp(sentence.length * 200, 2000, 5000), action: sentence, dialogue: [], characterIds: present });
      }
      continue;
    }
    const speaker = characterByName(beat.character);
    if (!speaker) continue;
    for (const chunk of chunkText(beat.line, MAX_CHUNK)) {
      const replying = previousSpeaker !== undefined && previousSpeaker !== speaker.id;
      const size: ShotSize = chunk.length >= LONG_LINE ? "close" : replying ? "over-shoulder" : "medium";
      add({ size, move: size === "close" ? "push-in" : "static", durationMs: clamp(Math.ceil(chunk.length / CHARS_PER_SECOND) * 1000, 1500, 12000), action: "", dialogue: [{ characterId: speaker.id, line: chunk }], characterIds: size === "over-shoulder" && previousSpeaker ? [speaker.id, previousSpeaker] : [speaker.id] });
    }
    previousSpeaker = speaker.id;
  }
  return shots;
}

/** Same rule the plan pipeline uses for a scene: spoken lines are shown as a quote, everything else as a title card. */
const defaultMgKind = (shot: { dialogue: unknown[] }): MgKind => shot.dialogue.length ? "quote" : "title";

const SIZE_ZH: Record<ShotSize, string> = { wide: "远景，交代环境", medium: "中景", close: "特写，聚焦面部表情", "over-shoulder": "过肩镜头", insert: "细节镜头" };
const MOVE_ZH: Record<CameraMove, string> = { static: "固定机位", "push-in": "镜头缓慢推近", "pull-out": "镜头缓慢拉远", pan: "镜头横摇", tilt: "镜头俯仰摇", handheld: "手持跟拍" };

/** The look a shot uses for a character: explicit choice, else first approved, else first. */
export function lookFor(shot: Pick<Shot, "lookIds">, character: Character): Look {
  const chosen = shot.lookIds?.[character.id];
  return character.looks.find(look => look.id === chosen) ?? character.looks.find(look => look.approved) ?? character.looks[0]!;
}

/** Rebuilds every shot's prompts from the current looks, locations and style. Pure; returns a new series. */
export function refreshPrompts(series: Series): Series {
  const characters = new Map(series.characters.map(character => [character.id, character]));
  const locations = new Map(series.locations.map(location => [location.id, location]));
  const episodes = series.episodes.map(episode => ({
    ...episode,
    scenes: episode.scenes.map(scene => ({
      ...scene,
      shots: scene.shots.map(shot => {
        const location = locations.get(shot.locationId);
        const people = shot.characterIds.map(characterId => characters.get(characterId)).filter((c): c is Character => !!c).map(character => {
          const look = lookFor(shot, character);
          return `${character.name}${look.prompt ? `（${look.prompt}）` : ""}`;
        });
        const spoken = shot.dialogue.map(line => `${characters.get(line.characterId)?.name ?? ""}说话`).filter(Boolean);
        const imagePrompt = [series.style.prompt, SIZE_ZH[shot.size], location ? `${location.name}${location.prompt ? `，${location.prompt}` : ""}${scene.timeOfDay ? `，${scene.timeOfDay}` : ""}` : "", people.join("、"), shot.action || spoken.join("、")].filter(Boolean).join("，").slice(0, 3000);
        const videoPrompt = [imagePrompt, MOVE_ZH[shot.move], `${Math.round(shot.durationMs / 100) / 10}秒`].join("，").slice(0, 3000);
        // An MG shot is rendered by a built-in scene from its text; it has no image or video prompt to keep consistent.
        return shot.engine === "mg" ? { ...shot, imagePrompt: "", videoPrompt: "" } : { ...shot, imagePrompt, videoPrompt };
      }),
    })),
  }));
  return { ...series, episodes };
}

/**
 * Takes character looks, voices and location references from the project's own asset identities, the
 * same records the character panel edits and the session layer freezes on approval. A look is approved
 * exactly when its identity carries an approval snapshot for the current version, so there is one place
 * where approval lives. Characters and locations are matched by name (or alias).
 */
export function applyIdentities(series: Series, assets: readonly AssetIdentity[]): Series {
  const characters = series.characters.map(character => {
    const asset = assets.find(entry => entry.kind === "character" && (entry.name === character.name || character.aliases.includes(entry.name)));
    if (!asset) return character;
    const look: Look = {
      id: `${character.id}-${asset.id}`,
      name: `${asset.name} v${asset.version}`,
      prompt: (asset.description ?? "").slice(0, 600),
      referenceAssetIds: [...(asset.approval?.refs ?? asset.refs ?? [])].slice(0, 8),
      approved: asset.approval !== undefined && asset.approval.version === asset.version,
    };
    return { ...character, looks: [look], voice: asset.voice ? { engine: "project-identity", voiceId: asset.voice } : character.voice };
  });
  const locations = series.locations.map(location => {
    const asset = assets.find(entry => entry.kind === "location" && entry.name === location.name);
    return asset ? { ...location, prompt: (asset.description ?? location.prompt).slice(0, 600), referenceAssetIds: [...(asset.refs ?? [])].slice(0, 8) } : location;
  });
  return refreshPrompts({ ...series, characters, locations });
}
export interface RescreenplayResult { series: Series; keptScenes: number; changedScenes: number; newCharacters: string[]; goneCharacters: string[] }

/**
 * Re-imports an edited screenplay into an existing series. Characters (looks, voices, approvals)
 * and locations are matched by name or alias; a scene whose source text did not change keeps all
 * of its shots, assets and statuses; a changed scene gets a fresh draft shot list.
 */
export function reimportScreenplay(previous: Series, text: string, options: Pick<BuildOptions, "episodeSize"> = {}): RescreenplayResult {
  const fresh = buildSeries(text, { engine: previous.defaultEngine, id: previous.id, title: previous.title, aspect: previous.aspect, style: previous.style, episodeSize: options.episodeSize, seed: { characters: previous.characters, locations: previous.locations } });
  const pool = previous.episodes.flatMap(episode => episode.scenes);
  const taken = new Set<string>();
  let keptScenes = 0, changedScenes = 0;
  const episodes = fresh.episodes.map(episode => ({
    ...episode,
    scenes: episode.scenes.map(scene => {
      const match = pool.find(candidate => !taken.has(candidate.id) && candidate.fingerprint === scene.fingerprint);
      if (!match) { changedScenes++; return scene; }
      taken.add(match.id);
      keptScenes++;
      return { ...scene, shots: match.shots.map((shot, i) => ({ ...shot, id: `${scene.id}-sh-${i + 1}`, index: i + 1, locationId: scene.locationId })) };
    }),
  }));
  const previousIds = new Set(previous.characters.map(character => character.id));
  const freshIds = new Set(fresh.characters.map(character => character.id));
  return {
    series: refreshPrompts({ ...fresh, episodes }),
    keptScenes,
    changedScenes,
    newCharacters: fresh.characters.filter(character => !previousIds.has(character.id)).map(character => character.name),
    goneCharacters: previous.characters.filter(character => !freshIds.has(character.id)).map(character => character.name),
  };
}

export type IssueLevel = "error" | "warn";
export interface ContinuityIssue { level: IssueLevel; code: string; where: string; message: string }

/** Deterministic checks that catch what breaks a drama between shots: bad references, jumps in look, impossible timing. */
export function checkContinuity(series: Series): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const add = (level: IssueLevel, code: string, where: string, message: string) => issues.push({ level, code, where, message });
  const characters = new Map(series.characters.map(character => [character.id, character]));
  const locations = new Set(series.locations.map(location => location.id));
  const seen = new Set<string>();
  for (const episode of series.episodes) {
    for (const scene of episode.scenes) {
      if (!scene.shots.length) add("error", "scene-empty", scene.id, `「${scene.heading}」没有镜头`);
      else if (scene.shots[0]!.size !== "wide") add("warn", "no-establishing", scene.id, `「${scene.heading}」不是以远景开场，观众可能看不清空间`);
      if (!locations.has(scene.locationId)) add("error", "unknown-location", scene.id, `场景引用了不存在的地点 ${scene.locationId}`);
      const lastLook = new Map<string, string>();
      for (const shot of scene.shots) {
        if (seen.has(shot.id)) add("error", "duplicate-shot", shot.id, `镜头编号重复：${shot.id}`);
        seen.add(shot.id);
        if (!locations.has(shot.locationId)) add("error", "unknown-location", shot.id, `镜头引用了不存在的地点 ${shot.locationId}`);
        if (shot.durationMs < MIN_SHOT_MS || shot.durationMs > MAX_SHOT_MS) add("error", "bad-duration", shot.id, `镜头时长 ${shot.durationMs}ms 超出 ${MIN_SHOT_MS}–${MAX_SHOT_MS}ms`);
        if (shot.engine === "mg" && !shot.mgKind) add("error", "mg-kind-missing", shot.id, "MG 镜头没有指定用哪种内置场景渲染");
        for (const characterId of shot.characterIds) {
          const character = characters.get(characterId);
          if (!character) { add("error", "unknown-character", shot.id, `镜头引用了不存在的角色 ${characterId}`); continue; }
          // Looks only matter where a model has to draw the person; an MG shot shows text and graphics.
          if (shot.engine !== "aigc") continue;
          const look = lookFor(shot, character);
          if (!look.approved) add("warn", "look-not-approved", shot.id, `${character.name} 的造型「${look.name}」还没有定稿，生成的人物可能前后不一致`);
          const before = lastLook.get(characterId);
          if (before && before !== look.id) add("warn", "look-jump", shot.id, `${character.name} 在同一场景内从造型「${before}」切到「${look.id}」`);
          lastLook.set(characterId, look.id);
        }
        for (const line of shot.dialogue) {
          if (!characters.has(line.characterId)) add("error", "unknown-character", shot.id, `对白引用了不存在的角色 ${line.characterId}`);
          else if (!shot.characterIds.includes(line.characterId)) add("error", "speaker-not-in-shot", shot.id, `${characters.get(line.characterId)!.name} 在说话，但不在这个镜头里`);
        }
      }
    }
  }
  return issues;
}

export interface ModelChoice { imageModelId?: string; videoModelId?: string; speechModelId?: string }
export interface EpisodeQuote { lines: BudgetLine[]; budget: BudgetCheck; shots: number; aigcShots: number; mgShots: number; seconds: number }

const MG_QUOTE_ID = "glint-mg";

/**
 * Prices one episode before anything is generated. AIGC shots cost a first frame and video seconds
 * (rounded up per shot, as providers bill it) plus the reference images the series still lacks; MG
 * shots are rendered by Glint on this machine and cost nothing. Speech is billed on every shot that
 * has dialogue, whichever way the picture is made. A model is only required when the episode needs it.
 */
export function quoteEpisode(series: Series, episodeId: string, registry: ModelRegistry, choice: ModelChoice, options: { capCny?: number; allowUnknown?: boolean; referenceImagesPerLook?: number } = {}): EpisodeQuote {
  const episode = series.episodes.find(entry => entry.id === episodeId);
  if (!episode) throw new Error(`Unknown episode ${episodeId}`);
  const shots = episode.scenes.flatMap(scene => scene.shots);
  const aigc = shots.filter(shot => shot.engine === "aigc"), mg = shots.filter(shot => shot.engine === "mg");
  const secondsOf = (list: readonly Shot[]) => list.reduce((sum, shot) => sum + Math.ceil(shot.durationMs / 1000), 0);
  const lines: BudgetLine[] = [];

  if (aigc.length) {
    if (!choice.imageModelId || !choice.videoModelId) throw new Error("本集有 AIGC 镜头，需要选择图像模型和视频模型");
    const image = registry.get(choice.imageModelId), video = registry.get(choice.videoModelId);
    if (image.kind !== "image") throw new Error(`${image.id} 不是图像模型`);
    if (video.kind !== "video") throw new Error(`${video.id} 不是视频模型`);
    const seconds = secondsOf(aigc);
    const used = new Set(aigc.flatMap(shot => shot.characterIds));
    const missingLooks = series.characters.filter(character => used.has(character.id)).flatMap(character => character.looks.filter(look => !look.approved && look.referenceAssetIds.length === 0));
    const usedLocations = new Set(aigc.map(shot => shot.locationId));
    const missingLocations = series.locations.filter(location => usedLocations.has(location.id) && location.referenceAssetIds.length === 0);
    const referenceImages = (missingLooks.length * (options.referenceImagesPerLook ?? 1)) + missingLocations.length;
    lines.push(
      { label: `参考图（${missingLooks.length} 个造型、${missingLocations.length} 个场景）`, quote: quote(image, { images: referenceImages, calls: referenceImages }) },
      { label: `AIGC 首帧图（${aigc.length} 镜）`, quote: quote(image, { images: aigc.length, calls: aigc.length }) },
      { label: `AIGC 视频（${seconds} 秒）`, quote: quote(video, { seconds, calls: aigc.length }) },
    );
  }
  if (mg.length) lines.push({ label: `MG 渲染（${mg.length} 镜，${secondsOf(mg)} 秒）`, quote: { modelId: MG_QUOTE_ID, costCny: 0, basis: "free-local", explain: "本机渲染，不产生费用" } });
  if (choice.speechModelId) {
    const speech = registry.get(choice.speechModelId);
    if (speech.kind !== "speech") throw new Error(`${speech.id} 不是语音模型`);
    const chars = shots.reduce((sum, shot) => sum + shot.dialogue.reduce((inner, line) => inner + line.line.length, 0), 0);
    lines.push({ label: `配音（${chars} 字）`, quote: quote(speech, { chars, calls: shots.filter(shot => shot.dialogue.length).length }) });
  }
  return { lines, budget: checkBudget(lines, options), shots: shots.length, aigcShots: aigc.length, mgShots: mg.length, seconds: secondsOf(shots) };
}

/** Switches one shot between MG and AIGC. Returns a new series; going to MG picks the default scene kind, going to AIGC clears it. */
export function setShotEngine(series: Series, shotId: string, engine: ShotEngine, mgKind?: MgKind): Series {
  let found = false;
  const episodes = series.episodes.map(episode => ({ ...episode, scenes: episode.scenes.map(scene => ({ ...scene, shots: scene.shots.map(shot => {
    if (shot.id !== shotId) return shot;
    found = true;
    const { mgKind: _drop, ...rest } = shot;
    return engine === "mg" ? { ...rest, engine, mgKind: mgKind ?? shot.mgKind ?? defaultMgKind(shot) } : { ...rest, engine };
  }) })) }));
  if (!found) throw new Error(`Unknown shot ${shotId}`);
  return refreshPrompts({ ...series, episodes });
}
export interface ShotRow { episode: number; scene: string; shot: number; engine: "MG" | "AIGC"; size: string; move: string; seconds: number; speaker: string; line: string; characters: string; location: string; status: string }

export function shotTable(series: Series, episodeId: string): ShotRow[] {
  const episode = series.episodes.find(entry => entry.id === episodeId);
  if (!episode) throw new Error(`Unknown episode ${episodeId}`);
  const characters = new Map(series.characters.map(character => [character.id, character.name]));
  const locations = new Map(series.locations.map(location => [location.id, location.name]));
  return episode.scenes.flatMap(scene => scene.shots.map(shot => ({
    episode: episode.index, scene: scene.heading, shot: shot.index, engine: shot.engine === "mg" ? "MG" : "AIGC", size: SIZE_ZH[shot.size].split("，")[0]!, move: MOVE_ZH[shot.move], seconds: Math.round(shot.durationMs / 100) / 10,
    speaker: shot.dialogue.map(line => characters.get(line.characterId) ?? "").join("、"), line: shot.dialogue.map(line => line.line).join(" ") || shot.action,
    characters: shot.characterIds.map(characterId => characters.get(characterId) ?? characterId).join("、"), location: locations.get(shot.locationId) ?? shot.locationId, status: shot.status,
  })));
}

/** CSV with a guard so a cell that starts like a formula is not executed by a spreadsheet. */
export function shotTableCsv(rows: readonly ShotRow[]): string {
  const header = ["集", "场景", "镜号", "方式", "景别", "运镜", "秒", "说话人", "台词/动作", "出镜角色", "地点", "状态"];
  const cell = (value: string | number) => {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows.map(row => [row.episode, row.scene, row.shot, row.engine, row.size, row.move, row.seconds, row.speaker, row.line, row.characters, row.location, row.status])].map(columns => columns.map(cell).join(",")).join("\r\n") + "\r\n";
}
