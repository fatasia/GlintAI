import fs from "node:fs";
import path from "node:path";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { analyzeReference } from "./reference-video";
import { runMediaProcess } from "./native-process";
import { readArg } from "./glint-runtime";
const hasFlag = (args: string[], name: string): boolean => args.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));

/**
 * S06 long-form → short-form clips (minimal pipeline): detect shots, group
 * them into candidate segments (15–60s, motion-ranked), cut each with a
 * stream copy, and emit an editable SceneScript project per clip whose notes
 * keep the source timecode traceable. Subtitles/ASR are later stages.
 */

export interface ClipCandidate {
  id: string;
  startMs: number;
  endMs: number;
  motionScore: number | null;
  shotCount: number;
  file: string;
  projectFile: string;
  /** Mid-segment cover frame (assets/<id>.jpg); null when extraction failed. */
  coverFile: string | null;
}

export interface ClipResult {
  source: { videoPath: string; durationMs: number };
  clips: ClipCandidate[];
  manifestFile: string;
}

export async function clipLongForm(options: {
  videoPath: string; outDir: string; minSeconds?: number; maxSeconds?: number; maxClips?: number; reencode?: boolean; signal?: AbortSignal;
}): Promise<ClipResult> {
  const minMs = Math.max(5, options.minSeconds ?? 15) * 1000;
  const maxMs = Math.max(minMs + 1000, (options.maxSeconds ?? 60) * 1000);
  const maxClips = Math.min(20, Math.max(1, options.maxClips ?? 5));
  const videoPath = path.resolve(options.videoPath);
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const analysis = await analyzeReference({ videoPath, outDir: path.join(outDir, ".analysis"), signal: options.signal });
  const { durationMs: sourceDurationMs, width, height } = analysis.source;
  const shots = analysis.shots.filter(shot => shot.endMs > shot.startMs);
  if (!shots.length) throw new Error("No shots detected; the source may be a still or unreadable video");

  // Greedy grouping from shot boundaries: open a segment at a boundary and
  // close at the first boundary that reaches minMs (never past maxMs).
  const groups: Array<{ startMs: number; endMs: number; shots: typeof shots }> = [];
  let cursor = 0;
  while (cursor < shots.length) {
    const start = shots[cursor]!.startMs;
    let end = shots[cursor]!.endMs, index = cursor;
    while (index + 1 < shots.length && shots[index + 1]!.endMs - start < minMs) { index++; end = shots[index]!.endMs; }
    if (end - start > maxMs) end = start + maxMs;
    groups.push({ startMs: start, endMs: end, shots: shots.slice(cursor, index + 1) });
    cursor = index + 1;
  }
  // A partial measurement cannot be compared as if it covered the entire group.
  const ranked = groups
    .map(group => ({ ...group, motionScore: group.shots.some(shot => shot.motion === null) ? null : Math.round(group.shots.reduce((sum, shot) => sum + shot.motion! * (shot.endMs - shot.startMs), 0) * 1000) / 1000 }))
    .sort((a, b) => a.motionScore === null ? (b.motionScore === null ? a.startMs - b.startMs : 1) : b.motionScore === null ? -1 : b.motionScore - a.motionScore || a.startMs - b.startMs)
    .slice(0, maxClips)
    .sort((a, b) => a.startMs - b.startMs);

  const clips: ClipCandidate[] = [];
  for (const [index, group] of ranked.entries()) {
    const id = `clip-${String(index + 1).padStart(2, "0")}`;
    const file = path.join(outDir, "assets", `${id}.mp4`);
    const seek = ["-nostdin", "-v", "error", "-y", "-ss", String(group.startMs / 1000), "-to", String(group.endMs / 1000), "-i", videoPath];
    // Stream copy keeps this fast but aligns cuts to keyframes; pass --reencode
    // for frame-accurate boundaries when the source has sparse keyframes.
    await runMediaProcess("ffmpeg", options.reencode
      ? [...seek, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", file]
      : [...seek, "-c", "copy", file], { signal: options.signal });
    const durationSeconds = ((group.endMs - group.startMs) / 1000).toFixed(1);
    // Cover frame from the segment midpoint; the UI can show it before playing.
    const coverFile = path.join(outDir, "assets", `${id}.jpg`);
    try {
      await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", String((group.startMs + group.endMs) / 2000), "-i", videoPath, "-frames:v", "1", "-q:v", "3", coverFile], { signal: options.signal });
    } catch {
      fs.rmSync(coverFile, { force: true });
    }
    const project: SceneScriptProject = parseProject({
      schemaVersion: 1, id, title: `${"长片切片"} ${index + 1}`,
      aspect: height > width ? "9:16" : "16:9", knowledgeSources: [],
      scenes: [{
        id: "segment", kind: "video", src: `assets/${id}.mp4`, trimStartSec: 0,
        narration: { text: "长片切片：补写这条短片的文案。" },
        notes: `源时间码 ${group.startMs}ms–${group.endMs}ms（源片 ${path.basename(videoPath)}，时长 ${durationSeconds}s，镜头数 ${group.shots.length}，运动评分 ${group.motionScore ?? "无法测量"}）`,
      }],
    } satisfies Partial<SceneScriptProject> as never);
    const projectFile = path.join(outDir, `${id}.project.json`);
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
    clips.push({ id, startMs: group.startMs, endMs: group.endMs, motionScore: group.motionScore, shotCount: group.shots.length, file, projectFile, coverFile: fs.existsSync(coverFile) ? coverFile : null });
  }

  const manifestFile = path.join(outDir, "clips.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ source: { videoPath, durationMs: sourceDurationMs }, clips }, null, 2));
  return { source: { videoPath, durationMs: sourceDurationMs }, clips, manifestFile };
}

export async function runClipCommand(args: string[]): Promise<void> {
  const videoPath = readArg(args, "video"), outDir = readArg(args, "out");
  if (!videoPath || !outDir) throw new Error("clip requires --video=<file> and --out=<dir> (optional: --min=15 --max=60 --count=5 --reencode)");
  const result = await clipLongForm({
    videoPath, outDir,
    minSeconds: Number(readArg(args, "min")) || undefined,
    maxSeconds: Number(readArg(args, "max")) || undefined,
    maxClips: Number(readArg(args, "count")) || undefined,
    reencode: hasFlag(args, "reencode"),
  });
  console.log(`[glint] clip: ${result.clips.length} 条候选短片 → ${outDir}`);
  for (const clip of result.clips) console.log(`  ${clip.id}: ${(clip.startMs / 1000).toFixed(1)}s–${(clip.endMs / 1000).toFixed(1)}s · 运动 ${clip.motionScore ?? "无法测量"} · ${clip.file}`);
  console.log(`[glint] 清单：${result.manifestFile}；每条短片有独立可编辑工程（notes 含源时间码）。`);
}
