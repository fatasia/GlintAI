import fs from "node:fs";
import path from "node:path";
/** Reject playlists/references disguised as media before invoking any decoder. */
export function assertRecipeMediaMagic(file: string) {
  const fd = fs.openSync(file, "r"),
    bytes = Buffer.alloc(12);
  let count: number;
  try {
    count = fs.readSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const extension = path.extname(file).toLowerCase();
  const tag = (from: number, to: number) => bytes.subarray(from, to).toString("ascii");
  const accepted: Record<string, boolean> = {
    ".png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ".jpg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ".jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ".webp": tag(0, 4) === "RIFF" && tag(8, 12) === "WEBP",
    ".wav": tag(0, 4) === "RIFF" && tag(8, 12) === "WAVE",
    ".mp3": tag(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1]! & 224) === 224),
    ".mp4": tag(4, 8) === "ftyp",
    ".m4a": tag(4, 8) === "ftyp",
    ".webm": bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
  };
  if (count < 12 || !accepted[extension])
    throw new Error("Media bytes do not match the declared extension; playlists are unsupported");
}
