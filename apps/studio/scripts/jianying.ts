import fs from "node:fs";
import path from "node:path";
import { buildTimeline, parseProject, type NarrationSegment, type SceneScriptProject } from "@glintai/scenescript";

/**
 * JianYing (剪映专业版) draft export + SRT captions.
 *
 * EXPERIMENTAL, honestly scoped: the draft_content.json layout follows the
 * publicly documented draft schema (µs timebase, materials/tracks/segments):
 * in-scene motion stays baked in the plate, scene boundaries become cut
 * segments, captions become an editable text track, music becomes an audio
 * track. A real JianYing install may still reject or upgrade the
 * draft — treat the output as best-effort until opened and verified on an
 * actual install (2026-10: not machine-verified).
 */

export interface CaptionCue { startMs: number; endMs: number; text: string }

const SENTENCE_ENDERS = new Set(["。", "!", "?", ";", "!", "?", "……"]);

/**
 * Splits narration text into sentence-level cues. With word timings the
 * split walks the words and closes a sentence when its text ends with
 * punctuation; without timings, time is spread proportionally by character
 * weight (CJK=1). Mirrors the estimateWordTimings convention.
 */
export function buildCaptionCues(
  text: string,
  durationMs: number,
  segments?: NarrationSegment[],
): CaptionCue[] {
  const words = segments?.flatMap((segment) => segment.words ?? []) ?? [];
  if (words.length > 0) {
    const cues: CaptionCue[] = [];
    let current: { startMs: number; endMs: number; text: string } | null = null;
    for (const word of words) {
      if (!current) current = { startMs: word.startMs, endMs: word.endMs, text: "" };
      current.endMs = word.endMs;
      current.text += word.text;
      const trimmed = word.text.trimEnd();
      if (SENTENCE_ENDERS.has(trimmed.slice(-1))) {
        cues.push(current);
        current = null;
      }
    }
    if (current) cues.push(current);
    return cues.filter((cue) => cue.text.trim().length > 0);
  }
  // Proportional fallback: split on punctuation, weight by char count (CJK=1).
  const pieces = text.split(/(?<=[。!?;;!?])|(?<=,)/u).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length === 0) return [];
  const weightOf = (piece: string) => Array.from(piece).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e00 ? 1 : 0.55), 0);
  const totalWeight = pieces.reduce((sum, piece) => sum + weightOf(piece), 0);
  let cursor = 0;
  return pieces.map((piece) => {
    const duration = (weightOf(piece) / totalWeight) * durationMs;
    const cue = { startMs: Math.round(cursor), endMs: Math.round(cursor + duration), text: piece };
    cursor += duration;
    return cue;
  });
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000), minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000), millis = total % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * Whole-project caption cues on the absolute timeline, including narration
 * offsets and composition clipping. Used by standalone and draft SRT exports.
 */
export function buildProjectCues(project: SceneScriptProject): CaptionCue[] {
  const timeline = buildTimeline(parseProject(project));
  return timeline.entries.flatMap((entry) => {
    const originMs = entry.startMs + (entry.scene.narration.audioOffsetMs ?? 0);
    return buildCaptionCues(entry.scene.narration.text, entry.durationMs, entry.scene.narration.segments)
      .map((cue) => ({
        ...cue,
        startMs: Math.max(0, Math.min(timeline.totalMs, originMs + cue.startMs)),
        endMs: Math.max(0, Math.min(timeline.totalMs, originMs + cue.endMs)),
      }));
  }).filter((cue) => cue.text.trim().length > 0 && cue.endMs > cue.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export function formatSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text.trim()}`)
    .join("\n\n") + "\n";
}

const uuid = () =>
  `${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}-4${Math.random().toString(16).slice(2, 5)}-a${Math.random().toString(16).slice(2, 5)}-${Math.random().toString(16).slice(2, 14)}`.slice(0, 36);

const US = 1_000_000; // JianYing timebase is microseconds.

export interface JianyingExportInput {
  project: SceneScriptProject;
  /** Final MP4 (the plate or narrated cut) the draft references. */
  videoPath: string;
  videoSpec: { width: number; height: number; fps: number; durationSec: number };
  /** Absolute path of the music file to lay on an audio track, if any. */
  musicPath?: string;
  outDir: string;
}

export interface JianyingExportResult {
  draftDir: string;
  srtPath: string;
  captionCueCount: number;
  sceneSegmentCount: number;
}

export function exportJianyingDraft(input: JianyingExportInput): JianyingExportResult {
  const { project, videoPath, videoSpec, musicPath, outDir } = input;
  const fps = project.fps ?? (Math.round(videoSpec.fps) || 30);
  const timeline = buildTimeline(parseProject(project));

  const draftId = uuid();
  const videoMaterialId = uuid();
  const videoMaterial = {
    id: videoMaterialId,
    type: "video",
    material_name: path.basename(videoPath),
    path: path.resolve(videoPath).replace(/\\/g, "/"),
    duration: Math.round(videoSpec.durationSec * US),
    width: videoSpec.width,
    height: videoSpec.height,
    has_audio: 1,
  };

  const videoSegments = timeline.entries.map((entry) => {
    const startUs = Math.round((entry.startMs / 1000) * US);
    const durationUs = Math.round((entry.durationMs / 1000) * US);
    return {
      id: uuid(),
      material_id: videoMaterialId,
      target_timerange: { start: startUs, duration: durationUs },
      source_timerange: { start: startUs, duration: durationUs },
      extra_material_refs: [],
      clip: { alpha: 1, flip: "", rotation: 0, scale: 1, transform: "x=0 y=0" },
    };
  });

  const textSegments: object[] = [];
  const textMaterials: object[] = [];
  for (const entry of timeline.entries) {
    const cues = buildCaptionCues(
      entry.scene.narration.text,
      entry.durationMs,
      entry.scene.narration.segments,
    );
    for (const cue of cues) {
      const materialId = uuid();
      textMaterials.push({
        id: materialId,
        type: "text",
        content: JSON.stringify({ text: cue.text, styles: [{ fill: { content: { solid: { color: [1, 1, 1] } } }, size: 8 }] }),
        font_size: 8,
        text_color: "#FFFFFF",
        background_color: "",
      });
      textSegments.push({
        id: uuid(),
        material_id: materialId,
        target_timerange: {
          start: Math.round((entry.startMs / 1000 + cue.startMs / 1000) * US),
          duration: Math.max(1, Math.round(((cue.endMs - cue.startMs) / 1000) * US)),
        },
        source_timerange: null,
        extra_material_refs: [],
        clip: { alpha: 1, flip: "", rotation: 0, scale: 1, transform: "x=0 y=-0.78" },
      });
    }
  }

  const materials: Record<string, unknown[]> = { videos: [videoMaterial], texts: textMaterials, audios: [] };
  const tracks: object[] = [
    { id: uuid(), type: "video", attribute: 0, flag: 0, segments: videoSegments },
    { id: uuid(), type: "text", attribute: 0, flag: 0, segments: textSegments },
  ];

  if (musicPath && fs.existsSync(musicPath)) {
    const audioMaterialId = uuid();
    const stat = fs.statSync(musicPath);
    materials.audios!.push({
      id: audioMaterialId,
      type: "extract_music",
      material_name: path.basename(musicPath),
      path: path.resolve(musicPath).replace(/\\/g, "/"),
      duration: Math.round(stat.size / 32), // unknown without decoding; JianYing re-reads the file
      has_audio: 1,
    });
    tracks.push({
      id: uuid(), type: "audio", attribute: 0, flag: 0,
      segments: [{
        id: uuid(),
        material_id: audioMaterialId,
        target_timerange: { start: 0, duration: Math.round((timeline.totalMs / 1000) * US) },
        source_timerange: null,
        extra_material_refs: [],
        volume: 0.4,
      }],
    });
  }

  const draft = {
    id: draftId,
    fps,
    duration: Math.round((timeline.totalMs / 1000) * US),
    canvas_config: { width: videoSpec.width, height: videoSpec.height, ratio: project.aspect === "9:16" ? "original" : "original" },
    platform: { os: process.platform === "darwin" ? "mac" : "windows", os_version: "n/a", app_id: 3704, app_source: "trial", app_version: "6.0.0" },
    create_time: Date.now() / 1000,
    materials,
    tracks,
    extra_info: { generator: "glint-jianying-export v1 (experimental)" },
  };

  const draftDir = path.join(outDir, `glint_${project.id}_draft`);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, "draft_content.json"), JSON.stringify(draft, null, 2));
  fs.writeFileSync(path.join(draftDir, "draft_meta_info.json"), JSON.stringify({
    draft_id: draftId,
    draft_name: project.title,
    draft_fold_path: draftDir.replace(/\\/g, "/"),
    tm_draft_create: Date.now() * 1000,
    tm_draft_modify: Date.now() * 1000,
    draft_materials: [],
  }, null, 2));

  const cues = buildProjectCues(project);
  const srtPath = path.join(outDir, `${project.id}.srt`);
  fs.writeFileSync(srtPath, formatSrt(cues), "utf8");

  return {
    draftDir,
    srtPath,
    captionCueCount: cues.length,
    sceneSegmentCount: videoSegments.length,
  };
}
