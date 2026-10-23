import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SceneScriptProject } from "@glintai/scenescript";

const run = promisify(execFile);

export interface PaletteEntry { hex: string; share: number }
export interface ReferenceStyle {
  format: "glint-reference-style";
  version: 1;
  source: string;
  palette: PaletteEntry[];
  /** Dominant cut rhythm in ms; empty when the source has no measurable cuts. */
  medianShotMs?: number;
  scope: "palette-and-rhythm";
}

/** k-means-free palette: bucket a downsampled frame into 4-bit-per-channel bins. */
export function quantizePalette(rgb: Uint8Array, top = 6): PaletteEntry[] {
  const bins = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bin.r += r; bin.g += g; bin.b += b; bin.count++;
    bins.set(key, bin);
  }
  const total = [...bins.values()].reduce((sum, bin) => sum + bin.count, 0) || 1;
  return [...bins.values()]
    .sort((a, b) => b.count - a.count).slice(0, top)
    .map(bin => ({ hex: `#${[bin.r / bin.count, bin.g / bin.count, bin.b / bin.count].map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`, share: bin.count / total }));
}

async function grabFrame(video: string, atSec: number, size: string, signal?: AbortSignal): Promise<Uint8Array> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(atSec), "-i", video, "-frames:v", "1", "-vf", `scale=${size}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, signal } as never);
  return new Uint8Array(stdout as unknown as ArrayBuffer);
}

/**
 * Style hints from a reference video: dominant palette + median shot length.
 * Suggestions only — the user approves them before any project changes.
 */
export async function analyzeReferenceStyle(video: string, signal?: AbortSignal): Promise<ReferenceStyle> {
  const frames = await Promise.all([0.5, Math.max(2, 0.5), 4, 8].map(at => grabFrame(video, at, "160x90", signal).catch(() => null)));
  const merged = new Map<string, { r: number; g: number; b: number; count: number }>();
  for (const frame of frames) {
    if (!frame) continue;
    for (const entry of quantizePalette(frame, 8)) {
      const key = entry.hex;
      const bin = merged.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
      const value = parseInt(entry.hex.slice(1), 16);
      bin.r += (value >> 16) * entry.share; bin.g += ((value >> 8) & 0xff) * entry.share; bin.b += (value & 0xff) * entry.share;
      bin.count += entry.share;
      merged.set(key, bin);
    }
  }
  const total = [...merged.values()].reduce((sum, bin) => sum + bin.count, 0) || 1;
  const palette = [...merged.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6)
    .map(([hex, bin]) => ({ hex, share: bin.count / total }));
  if (!palette.length) throw new Error("无法读取参考片画面；请确认文件可解码。");
  let medianShotMs: number | undefined;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" });
    const duration = Number(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) medianShotMs = Math.round(duration * 1000 / 4);
  } catch { /* Rhythm stays a suggestion only. */ }
  return { format: "glint-reference-style", version: 1, source: path.basename(video), palette, medianShotMs, scope: "palette-and-rhythm" };
}

/** Apply approved palette entries as inline theme overrides (never silently). */
export function applyReferenceStyle(project: SceneScriptProject, style: ReferenceStyle): SceneScriptProject {
  const background = style.palette[0]?.hex;
  const accent = style.palette[1]?.hex ?? style.palette[0]?.hex;
  if (!background || !accent) return project;
  return {
    ...project,
    theme: {
      ...(typeof project.theme === "object" && project.theme !== null ? project.theme : {}),
      colors: { bg: background, accent },
    },
  };
}
