import fs from "node:fs";
import { detectBeats, type BeatGrid } from "@glintai/music";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { readArg } from "./glint-runtime";

export function parseBeatGrid(value: unknown): BeatGrid {
  const grid = value as BeatGrid;
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm < 0 || grid.bpm > 400 || !Array.isArray(grid.beatsMs) || grid.beatsMs.length > 100000 || grid.beatsMs.some((ms, i) => !Number.isFinite(ms) || ms < 0 || i > 0 && ms <= grid.beatsMs[i - 1]!)) throw new Error("节拍网格需要 bpm 和严格递增的非负 beatsMs 数组");
  return { bpm: grid.bpm, beatsMs: [...grid.beatsMs] };
}

/** A confidence guard, not an accuracy claim. Syncopation and half-time can still fool energy peaks. */
export function beatRegularity(grid: BeatGrid): number {
  if (grid.beatsMs.length < 4 || grid.bpm <= 0) return 0;
  const period = 60000 / grid.bpm;
  const errors = grid.beatsMs.slice(1).map((ms, i) => { const ratio = (ms - grid.beatsMs[i]!) / period; return Math.abs(ratio - Math.round(ratio)); });
  return Math.max(0, 1 - errors.reduce((a, b) => a + b, 0) / errors.length * 4);
}

export async function beatsForMake(args: string[]): Promise<BeatGrid | undefined> {
  if (args.includes("--no-beats")) return undefined;
  const file = readArg(args, "beats-grid");
  if (file) return parseBeatGrid(JSON.parse(fs.readFileSync(file, "utf8")));
  const music = readArg(args, "music");
  if (!music || ["auto", "off", "synth", "existing", "minimax", "gateway"].includes(music)) return undefined;
  const grid = await detectBeats(music);
  if (beatRegularity(grid) < 0.65) { console.warn("[glint] beats: 拍点稀少或不规则,跳过自动脉冲。可用 --beats-grid=已校准网格 或 --no-beats;音乐仍播放。"); return undefined; }
  console.log(`[glint] beats: ~${grid.bpm} BPM (能量启发式,可用 --beats-grid 覆盖)`);
  return grid;
}

/** Called after real narration timing is known, including CSV and overlapping scenes. */
export function injectBeatGrid(project: SceneScriptProject, grid: BeatGrid) {
  parseBeatGrid(grid);
  for (const entry of buildTimeline(project).entries) {
    if (entry.scene.beatPulse) continue; // Explicit professional edits win.
    const local = grid.beatsMs.filter(ms => ms >= entry.startMs && ms < entry.startMs + entry.durationMs).map(ms => ms - entry.startMs);
    if (local.length > 1000) throw new Error(`场景 ${entry.scene.id} 拍点超过 1000,请缩短场景或精简网格`);
    if (local.length) entry.scene.beatPulse = { beatsMs: local };
  }
  return project;
}

export function fixedBeatGrid(bpm: number, durationMs: number, offsetMs = 0): BeatGrid {
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000 || !Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs >= durationMs) throw new Error("固定网格需要 BPM 30–300、时长 0–3600 秒和有效起拍偏移");
  return { bpm, beatsMs: Array.from({ length: Math.ceil((durationMs - offsetMs) * bpm / 60000) }, (_, i) => Math.round(offsetMs + i * 60000 / bpm)) };
}
