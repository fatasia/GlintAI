import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { RecipeInput } from "@glintai/composer/recipe-inputs";
import { BoundRecipeAsset } from "@glintai/composer/recipe-v2";
import { checkedPath } from "./recipe-files";
import { assertRecipeMediaMagic } from "./recipe-magic";
const extensions = {
  image: [".png", ".jpg", ".jpeg", ".webp"],
  audio: [".wav", ".mp3", ".m4a"],
  video: [".mp4", ".webm"],
};
export function recipeFileHash(file: string) {
  checkedPath(file);
  const fd = fs.openSync(file, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024)
      throw new Error("Asset must be a bounded regular file");
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
    return { sha256: hash.digest("hex"), bytes: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}
export function probeRecipeAsset(file: string, kind: "image" | "audio" | "video") {
  const extension = path.extname(file).toLowerCase();
  if (!extensions[kind].includes(extension))
    throw new Error("Asset extension does not match declared kind");
  checkedPath(file);
  assertRecipeMediaMagic(file);
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20000, windowsHide: true },
  );
  const result: {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }[];
    format?: { duration?: string };
  } = JSON.parse(raw);
  const video = result.streams?.find((stream) => stream.codec_type === "video"),
    audio = result.streams?.find((stream) => stream.codec_type === "audio");
  const durationMs = Math.round(
    Number(result.format?.duration ?? audio?.duration ?? video?.duration ?? 0) * 1000,
  );
  if (
    kind === "image" &&
    (!video || audio || !["png", "mjpeg", "webp"].includes(video.codec_name ?? ""))
  )
    throw new Error("Image bytes are not a supported still image");
  if (kind === "audio" && (!audio || video || !Number.isFinite(durationMs) || durationMs <= 0))
    throw new Error("Audio must decode to an audio-only stream");
  if (kind === "video" && (!video || !Number.isFinite(durationMs) || durationMs <= 0))
    throw new Error("Video stream is missing or invalid");
  return {
    durationMs: kind === "image" ? 0 : durationMs,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(audio),
  };
}
function copyOwned(source: string, destination: string) {
  checkedPath(source);
  const input = fs.openSync(source, "r");
  let output: number | undefined;
  try {
    output = fs.openSync(destination, "wx");
    const buffer = Buffer.alloc(65536);
    let count;
    while ((count = fs.readSync(input, buffer, 0, buffer.length, null)))
      fs.writeFileSync(output, buffer.subarray(0, count));
    fs.fsyncSync(output);
  } catch (error) {
    if (output !== undefined) {
      fs.closeSync(output);
      output = undefined;
      fs.unlinkSync(destination);
    }
    throw error;
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}
export function importRecipeAssets(input: RecipeInput, base: string, directory: string) {
  const assets: BoundRecipeAsset[] = [];
  fs.mkdirSync(path.join(directory, "assets"));
  let total = 0;
  for (const asset of input.assets) {
    const source = path.resolve(base, asset.file);
    if (!source.startsWith(path.resolve(base) + path.sep))
      throw new Error("Asset escapes input directory");
    const before = recipeFileHash(source);
    total += before.bytes;
    if (total > 512 * 1024 * 1024) throw new Error("Assets exceed 512 MiB");
    const extension = path.extname(source).toLowerCase();
    if (!extensions[asset.kind].includes(extension)) throw new Error("Unsupported asset extension");
    const file = "assets/" + asset.id + extension,
      destination = path.join(directory, file);
    copyOwned(source, destination);
    try {
      const after = recipeFileHash(destination);
      if (after.sha256 !== before.sha256) throw new Error("Asset changed during copy");
      assets.push(
        BoundRecipeAsset.parse({
          ...asset,
          file,
          ...after,
          ...probeRecipeAsset(destination, asset.kind),
        }),
      );
    } catch (error) {
      fs.unlinkSync(destination);
      throw error;
    }
  }
  return assets;
}
export function verifyRecipeAssets(directory: string, assets: BoundRecipeAsset[]) {
  for (const asset of assets) {
    const actual = recipeFileHash(path.join(directory, asset.file));
    if (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes)
      throw new Error("Approved asset changed: " + asset.id);
  }
}
