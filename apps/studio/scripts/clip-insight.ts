import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { llmFromEnvironment, type LlmProvider } from "@glintai/llm";
import { transcribeAudio, segmentTranscript, type Transcript } from "@glintai/composer/asr";
import { formatSrt, type CaptionCue } from "./jianying";

/**
 * CLIP-01 代理转写 + CLIP-02 语义亮点：对 `glint clip` 产出的切片清单逐片
 * 转写（音频侧链→多模态文本模型）并按语义挑亮点。清单原文件不覆盖语义字段
 * 以外的内容；每片字幕写 `<clip 项目目录>/<id>.srt`。
 */

interface ClipEntry { id: string; startMs: number; endMs: number; file?: string; projectFile?: string; motionScore?: number | null; transcript?: string; srtFile?: string; highlight?: boolean; highlightReason?: string }

function probeAudio(file: string): { durationMs: number } {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8", timeout: 30_000 });
  const duration = Number(JSON.parse(probe.stdout || "{}").format?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`无法读取音频时长：${file}；确认片段含音轨。`);
  return { durationMs: Math.round(duration * 1000) };
}

/** CLIP-01: transcribe every clip's audio track into per-clip SRT + manifest text. */
export async function transcribeClips(options: { manifestFile: string; model: string; signal?: AbortSignal; chat?: unknown }): Promise<{ transcripts: number; manifestFile: string }> {
  const manifestPath = path.resolve(options.manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const clips: ClipEntry[] = Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.length) throw new Error("清单里没有 clips；先运行 glint clip。");
  const llm = (options.chat ?? llmFromEnvironment()) as Parameters<typeof transcribeAudio>[0]["client"];
  let done = 0;
  for (const clip of clips) {
    if (!clip.file) continue;
    const source = path.resolve(path.dirname(manifestPath), clip.file);
    if (!fs.existsSync(source)) continue;
    const { durationMs } = probeAudio(source);
    const transcript: Transcript = await transcribeAudio({ audio: new Uint8Array(fs.readFileSync(source)), format: "mp3", durationMs, model: options.model, client: llm, signal: options.signal });
    clip.transcript = transcript.text;
    const cues: CaptionCue[] = transcript.segments.length
      ? transcript.segments.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text }))
      : segmentTranscript(transcript.text, durationMs).map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text }));
    if (cues.length) {
      const srtFile = path.join(path.dirname(source), `${clip.id}.srt`);
      fs.writeFileSync(srtFile, formatSrt(cues), "utf8");
      clip.srtFile = path.relative(path.dirname(manifestPath), srtFile);
    }
    done++;
  }
  if (!done) throw new Error("没有任何片段带可转写的音频文件；确认 clips[].file 指向真实切片。");
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, clips }, null, 2));
  return { transcripts: done, manifestFile: manifestPath };
}

/** CLIP-02: pick semantic highlights among clips using transcript + metadata only. */
export async function pickHighlights(options: { manifestFile: string; brief?: string; top?: number; signal?: AbortSignal; llm?: LlmProvider }): Promise<{ highlights: string[]; manifestFile: string }> {
  const manifestPath = path.resolve(options.manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const clips: ClipEntry[] = Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.length) throw new Error("清单里没有 clips；先运行 glint clip。");
  const top = Math.max(1, Math.min(options.top ?? 3, clips.length));
  const brief = (clips as Array<ClipEntry>).map((clip, index) =>
    `${index}:${clip.id} ${((clip.endMs - clip.startMs) / 1000).toFixed(0)}s 运动${clip.motionScore ?? "无法测量"}${clip.transcript ? ` 旁白「${clip.transcript.slice(0, 120)}」` : ""}`).join("\n");
  const llm = options.llm ?? llmFromEnvironment();
  const response = await llm.chat({
    system: [
      "你是长片切片的选段编辑。输入是候选片段清单（序号:id 时长 运动分 旁白）。",
      `任务：${options.brief ?? "挑出最适合独立传播的高光片段"}`,
      `只输出 JSON：{"highlights":[{"index":序号,"reason":"≤30字入选理由"}]}，最多 ${top} 条；只依据给出的信息，不编造画面事实。`,
    ].join("\n"),
    messages: [{ role: "user", content: brief }], json: true, temperature: 0.3, timeoutMs: 120_000, signal: options.signal,
  });
  const jsonText = response.text.slice(Math.max(0, response.text.indexOf("{")), response.text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonText) as { highlights?: Array<{ index?: number; reason?: string }> };
  const picks = (parsed.highlights ?? []).filter(entry => Number.isInteger(entry.index) && (entry.index as number) >= 0 && (entry.index as number) < clips.length).slice(0, top);
  if (!picks.length) throw new Error("模型没有返回有效的片段序号；清单未修改。");
  for (const clip of clips) { clip.highlight = false; clip.highlightReason = undefined; }
  for (const pick of picks) {
    const clip = clips[pick.index as number]!;
    clip.highlight = true;
    clip.highlightReason = String(pick.reason ?? "").slice(0, 60);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, clips }, null, 2));
  return { highlights: picks.map(pick => clips[pick.index as number]!.id), manifestFile: manifestPath };
}
