import { z } from "zod";

/**
 * DRAMA-01 screenplay splitting (independent implementation): parse a plain
 * screenplay into episodes, scenes and a character table. Rule-based first —
 * the LLM layer can re-synopsis later; parsing must never need a model.
 *
 * Recognized scene headings (line-anchored):
 *   第X场 / 场景X / INT. LOCATION - TIME / EXT. LOCATION - TIME / 内景|外景 地点 日|夜
 * A dialogue line is "角色名：台词" or "角色名: 台词"; a bare short line that
 * matches a known character name starts a dialogue block too.
 */

export const DramaDialogue = z.object({ character: z.string().min(1), line: z.string().min(1) });
export const DramaScene = z.object({
  heading: z.string().min(1),
  location: z.string().min(1),
  timeOfDay: z.string().max(20),
  interior: z.boolean(),
  characters: z.array(z.string()).max(30),
  action: z.string().max(4000),
  dialogue: z.array(DramaDialogue).max(200),
  /** Script order of action and dialogue; `action` and `dialogue` stay as the grouped views. */
  beats: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("action"), text: z.string().min(1).max(4000) }),
    z.object({ kind: z.literal("dialogue"), character: z.string().min(1), line: z.string().min(1) }),
  ])).max(400).optional(),
});
export const DramaEpisode = z.object({
  index: z.number().int().min(1),
  title: z.string().min(1),
  scenes: z.array(DramaScene).min(1).max(200),
  characters: z.array(z.string()).max(50),
});
export type DramaEpisode = z.infer<typeof DramaEpisode>;
export type DramaScene = z.infer<typeof DramaScene>;
export type DramaDialogue = z.infer<typeof DramaDialogue>;

const SCENE_HEADING = /^(?:(第[一二三四五六七八九十百千0-9]+场)|(?:场景\s*\d+)|((?:INT|EXT|INT\/EXT)[.．].+)|(内景|外景)(?:\s*[·.．:：]?\s*(.+))?)/i;
const DIALOGUE_INLINE = /^([^：:]{1,20})[：:]\s*(.+)$/;

export interface DramaCharacter { name: string; episodes: number[]; lines: number; firstSceneHeading: string }

export interface ScreenplaySplit {
  episodes: DramaEpisode[];
  characters: DramaCharacter[];
  issues: string[];
}

const isNoise = (line: string) => !line || /^(—|--|\*\*\*|={3,}|~{3,})/.test(line) || /^\(.*\)$/.test(line);

/** Split a screenplay; every scene belongs to exactly one episode (sequential grouping). */
export function splitScreenplay(text: string, options: { episodeSize?: number } = {}): ScreenplaySplit {
  const episodeSize = Math.max(1, options.episodeSize ?? 6);
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const issues: string[] = [];
  const scenes: DramaScene[] = [];
  let current: DramaScene | null = null;
  const actionLines: string[] = [];
  const namedCharacters = new Set<string>();

  const flushAction = () => {
    if (current && actionLines.length) {
      const text = actionLines.splice(0).join("\n").slice(0, 4000);
      current.action = [current.action, text].filter(Boolean).join("\n").slice(0, 4000);
      (current.beats ??= []).push({ kind: "action", text });
    }
  };

  let consumedLine = -1;
  for (const [index, raw] of lines.entries()) {
    if (index === consumedLine) continue;
    if (isNoise(raw)) continue;
    const heading = SCENE_HEADING.exec(raw);
    if (heading && (heading[1] || heading[2] || heading[3])) {
      flushAction();
      // Chinese headings mark interior with a standalone 内/外 before the time word.
      const interior = (/内景|\bINT\b|\s内\s|\s内$/.test(raw) || /[·.．:：]\s*内\b/.test(raw)) && !/外景|\bEXT\b|\s外\s/.test(raw);
      let body = (heading[2] ?? heading[5] ?? raw.replace(/^(第[一二三四五六七八九十百千0-9]+场|场景\s*\d+)[·.．:：\s]*/, "")).trim();
      body = body.replace(/^(?:INT|EXT|INT\/EXT)[.．]\s*/i, "");
      // Dash-separated "LOC - TIME" (INT./EXT. style) or a trailing Chinese
      // time-of-day word ("茶馆 内 日") both feed timeOfDay.
      const parts = body.split(/\s*[-–—]\s*/);
      let location = (parts[0] ?? body).trim();
      let timeOfDay = (parts[1] ?? "").trim();
      if (!timeOfDay) {
        const timeMatch = location.match(/\s(日|夜|晨|清晨|黄昏|夜晚|傍晚)\s*$/);
        if (timeMatch) { timeOfDay = timeMatch[1]!; location = location.slice(0, timeMatch.index).trim(); }
      }
      location = location.replace(/\s*[内外]景?\s*$/, "").trim() || raw;
      current = { heading: raw, location, timeOfDay: timeOfDay || heading[4]?.trim() || "", interior, characters: [], action: "", dialogue: [] };
      scenes.push(current);
      continue;
    }
    const inline = DIALOGUE_INLINE.exec(raw);
    if (inline && current) {
      flushAction();
      const name = inline[1]!.trim();
      namedCharacters.add(name);
      if (!current.characters.includes(name)) current.characters.push(name);
      const line = inline[2]!.trim().slice(0, 2000);
      current.dialogue.push({ character: name, line });
      (current.beats ??= []).push({ kind: "dialogue", character: name, line });
      continue;
    }
    // A bare known-character line opens a dialogue block with the next line as the cue.
    if (current && namedCharacters.has(raw) && lines[index + 1] && !SCENE_HEADING.test(lines[index + 1]!)) {
      flushAction();
      if (!current.characters.includes(raw)) current.characters.push(raw);
      const line = lines[index + 1]!.trim().slice(0, 2000);
      current.dialogue.push({ character: raw, line });
      (current.beats ??= []).push({ kind: "dialogue", character: raw, line });
      consumedLine = index + 1;
      continue;
    }
    if (current) actionLines.push(raw);
    else issues.push(`第 ${index + 1} 行落在第一个场景标题之前，已忽略：${raw.slice(0, 40)}`);
  }
  flushAction();

  if (!scenes.length) return { episodes: [], characters: [], issues: [...issues, "未识别到任何场景标题（支持 第X场/INT./EXT./内景|外景）"] };

  // Sequential episode grouping: episodeSize scenes per episode, titled by range.
  const episodes: DramaEpisode[] = [];
  for (let start = 0; start < scenes.length; start += episodeSize) {
    const chunk = scenes.slice(start, start + episodeSize);
    const names = [...new Set(chunk.flatMap(scene => scene.characters))];
    episodes.push({
      index: episodes.length + 1,
      title: `第 ${episodes.length + 1} 集 · ${chunk[0]!.location} 起 · ${chunk.length} 场`,
      scenes: chunk,
      characters: names,
    });
  }
  const characters: DramaCharacter[] = [...namedCharacters].map(name => {
    const hits = episodes.filter(episode => episode.characters.includes(name));
    const firstScene = scenes.find(scene => scene.characters.includes(name))!;
    return { name, episodes: hits.map(episode => episode.index), lines: scenes.reduce((sum, scene) => sum + scene.dialogue.filter(line => line.character === name).length, 0), firstSceneHeading: firstScene.heading };
  }).sort((a, b) => b.lines - a.lines);
  return { episodes, characters, issues };
}
