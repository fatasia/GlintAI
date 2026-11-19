import fs from "node:fs";
import path from "node:path";
import { exportAlphaFrames } from "./alpha-frames";
import { runMediaProcess } from "./native-process";

/**
 * Encode the bounded SVG-only alpha frame sequence as silent VP9 WebM.
 * The exclusive link leaves an existing user file untouched, even on races.
 */
export async function exportAlphaWebm(options: { projectPath: string; out: string; width?: number; height?: number; signal?: AbortSignal }) {
  const output = path.resolve(options.out);
  if (path.extname(output).toLowerCase() !== ".webm") throw new Error("透明视频输出必须为 .webm 文件。");
  if (fs.existsSync(output)) throw new Error("输出文件已存在，不会覆盖。");
  options.signal?.throwIfAborted();
  const parent = fs.realpathSync(path.dirname(output));
  const workspace = fs.mkdtempSync(path.join(parent, ".glint-alpha-"));
  // Only delete the exclusively created temporary child of the requested parent.
  if (path.dirname(path.resolve(workspace)) !== parent) throw new Error("临时目录不在目标目录内。");
  try {
    const frames = await exportAlphaFrames({ projectPath: options.projectPath, outDir: path.join(workspace, "frames"), width: options.width, height: options.height, signal: options.signal });
    if (frames.width % 2 || frames.height % 2) throw new Error("透明 WebM 的宽高必须为偶数。");
    const temporary = path.join(workspace, "encoded.webm");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", "-framerate", frames.fps,
      "-i", path.join(workspace, "frames", "%06d.png"), "-map", "0:v:0", "-an",
      "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "4", "-crf", "20", "-b:v", "0",
      "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", temporary], { signal: options.signal, timeoutMs: 300_000 });
    options.signal?.throwIfAborted();
    const bytes = fs.statSync(temporary).size;
    if (!bytes) throw new Error("透明视频编码结果为空。");
    fs.linkSync(temporary, output);
    return { output, bytes, width: frames.width, height: frames.height, fps: frames.fps, frames: frames.frames, alpha: true, audio: false, scope: frames.scope };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
