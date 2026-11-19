import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureProcess } from "./frame-diff";
import { runMediaProcess } from "./native-process";

export interface CanvasExpansionOptions {
  src: string; out: string;
  left?: number; right?: number; top?: number; bottom?: number;
  color?: string; signal?: AbortSignal;
}

/** Expand a local image canvas only; no model, image extrapolation, or source modification. */
export async function expandImageCanvas(options: CanvasExpansionOptions) {
  const source = path.resolve(options.src), output = path.resolve(options.out), extension = path.extname(source).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension) || !fs.statSync(source).isFile()) throw new Error("Source must be a local PNG, JPEG or WebP image");
  if (path.extname(output).toLowerCase() !== ".png") throw new Error("Canvas output must use .png");
  if (source === output || fs.existsSync(output)) throw new Error("Output already exists; choose a new file");
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error("Output directory does not exist");
  const borders = { left: options.left ?? 0, right: options.right ?? 0, top: options.top ?? 0, bottom: options.bottom ?? 0 };
  if (Object.values(borders).some(value => !Number.isSafeInteger(value) || value < 0 || value > 4096) || !Object.values(borders).some(Boolean)) throw new Error("Margins must be integers from 0 to 4096, with at least one positive");
  const color = options.color ?? "transparent";
  if (color !== "transparent" && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Color must be transparent or #RRGGBB");
  const stat = fs.statSync(source);
  if (!stat.size || stat.size > 20 * 1024 * 1024) throw new Error("Source image must be between 1 byte and 20 MiB");
  options.signal?.throwIfAborted();
  const bytes = fs.readFileSync(source);
  if (bytes.length !== stat.size) throw new Error("Source image changed while reading");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = fs.mkdtempSync(path.join(path.dirname(output), ".glint-canvas-"));
  try {
    const input = path.join(directory, `source${extension}`), padded = path.join(directory, "canvas.png");
    fs.writeFileSync(input, bytes, { flag: "wx" });
    const probe = JSON.parse((await captureProcess("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", input], { signal: options.signal, timeoutMs: 30000 })).toString("utf8"));
    const stream = probe?.streams?.[0], width = stream?.width, height = stream?.height;
    if (!["png", "mjpeg", "webp"].includes(stream?.codec_name) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16_777_216) throw new Error("Unsupported image or source dimensions exceed 16 megapixels");
    const outWidth = width + borders.left + borders.right, outHeight = height + borders.top + borders.bottom;
    if (outWidth > 8192 || outHeight > 8192 || outWidth * outHeight > 16_777_216) throw new Error("Expanded canvas exceeds 8192 pixels per side or 16 megapixels");
    const fill = color === "transparent" ? "black@0" : `0x${color.slice(1)}`;
    const filter = `format=rgba,pad=${outWidth}:${outHeight}:${borders.left}:${borders.top}:color=${fill}`;
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", input, "-vf", filter, "-frames:v", "1", "-threads", "1", padded], { signal: options.signal, timeoutMs: 60000 });
    options.signal?.throwIfAborted();
    // Hard-link publication in the same directory is atomic and never replaces a competing output.
    fs.linkSync(padded, output);
    return { output, sourceSha256: sha256, source: { width, height }, canvas: { width: outWidth, height: outHeight }, origin: { x: borders.left, y: borders.top }, margins: borders, color, operation: "canvas-only" as const };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
