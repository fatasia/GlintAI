import fs from "node:fs";
import path from "node:path";
import { resumeBatch, runChunked, scheduleBatch } from "@glintai/composer";
import { runMediaProcess } from "./native-process";

/**
 * CLIP-05 批量导出：clips.json 清单 → 逐片 ffmpeg 真渲染（本地、零网关）→
 * 封面/文案随片出包 → exports.json 批量产物清单。并发与恢复复用 BATCH-04/05
 * 的 scheduleBatch + runChunked + resumeBatch（packages/composer，只读调用）：
 * 块间串行配额友好，单片失败不中断整批，重跑只补缺。
 * 产物路径相对 outDir 存（清单可搬运）；done 判定按「有记录且文件仍在」。
 */

export interface ClipManifestEntry {
  id: string;
  startMs: number;
  endMs: number;
  file: string;
  coverFile?: string | null;
}

export interface ClipCopyEntry { id: string; title: string; hook: string; caption: string }

export interface ClipExportEntry {
  id: string;
  /** 相对 outDir，如 exports/clip-01.mp4。 */
  mp4: string;
  bytes: number;
  cover: string | null;
  copy: ClipCopyEntry | null;
}

export interface ClipExportFailure { id: string; error: string }

export interface BatchExportResult {
  manifestFile: string;
  exports: ClipExportEntry[];
  failures: ClipExportFailure[];
  /** 本次跳过的已完成片数（幂等恢复）。 */
  doneSkipped: number;
}

interface StoredManifest { exportedAt: string; sourceManifest: string; exports: ClipExportEntry[]; failures: ClipExportFailure[] }

/** 默认渲染：切片资产重编码到导出目录（libx264+aac），封面原样随片。 */
async function renderClipFfmpeg(options: { source: string; out: string; coverSource: string | null; coverOut: string | null; crf: number; signal?: AbortSignal }): Promise<{ mp4: string }> {
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", options.source, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(options.crf), "-pix_fmt", "yuv420p", "-c:a", "aac", options.out], { signal: options.signal });
  if (options.coverSource && options.coverOut) fs.copyFileSync(options.coverSource, options.coverOut);
  return { mp4: options.out };
}

export async function exportClipsBatch(options: {
  manifestFile: string;
  outDir: string;
  maxConcurrent?: number;
  encoding?: "draft" | "balanced";
  signal?: AbortSignal;
  renderer?: (clip: ClipManifestEntry) => Promise<{ mp4: string }>;
}): Promise<BatchExportResult> {
  const manifestPath = path.resolve(options.manifestFile);
  const outDir = path.resolve(options.outDir);
  const exportDir = path.join(outDir, "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    clips?: ClipManifestEntry[];
    copy?: ClipCopyEntry[];
  };
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.length) throw new Error("清单里没有 clips；先运行 glint clip 生成切片。");
  const copyById = new Map((manifest.copy ?? []).map(entry => [entry.id, entry]));

  const storedFile = path.join(exportDir, "exports.json");
  const previous: StoredManifest = fs.existsSync(storedFile)
    ? JSON.parse(fs.readFileSync(storedFile, "utf8"))
    : { exportedAt: "", sourceManifest: "", exports: [], failures: [] };
  const resolveOut = (relative: string) => path.resolve(outDir, relative);
  const doneById = new Map(previous.exports.filter(entry => fs.existsSync(resolveOut(entry.mp4))).map(entry => [entry.id, entry]));
  const { todo, done } = resumeBatch(clips, { isDone: clip => doneById.has(clip.id) });

  const crf = options.encoding === "draft" ? 24 : 20;
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
  const renderer = options.renderer ?? ((clip: ClipManifestEntry) => renderClipFfmpeg({
    source: path.resolve(path.dirname(manifestPath), clip.file),
    out: path.join(exportDir, `${clip.id}.mp4`),
    coverSource: clip.coverFile ? path.resolve(path.dirname(manifestPath), clip.coverFile) : null,
    coverOut: clip.coverFile ? path.join(exportDir, `${clip.id}.cover.jpg`) : null,
    crf,
    signal: options.signal,
  }));

  // BATCH-04 并发模式：去重排队 + 封顶分块，块内并发、块间串行。
  const { chunks } = scheduleBatch(todo, { maxConcurrent, keyOf: clip => clip.id });
  const settled = await runChunked(chunks, renderer);

  const entries: ClipExportEntry[] = [...doneById.values()];
  const failures: ClipExportFailure[] = [];
  for (const outcome of settled) {
    const clip = outcome.item as ClipManifestEntry;
    if (!outcome.ok) { failures.push({ id: clip.id, error: outcome.error ?? "unknown" }); continue; }
    const mp4 = outcome.value!.mp4;
    entries.push({
      id: clip.id,
      mp4: path.relative(outDir, mp4),
      bytes: fs.statSync(mp4).size,
      cover: clip.coverFile ? exportName(clip.id, ".cover.jpg") : null,
      copy: copyById.get(clip.id) ?? null,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const output: StoredManifest = { exportedAt: new Date().toISOString(), sourceManifest: manifestPath, exports: entries, failures };
  fs.writeFileSync(storedFile, JSON.stringify(output, null, 2));
  return { manifestFile: storedFile, exports: entries, failures, doneSkipped: done.length };
}

function exportName(id: string, suffix: string): string {
  return `exports/${id}${suffix}`;
}
