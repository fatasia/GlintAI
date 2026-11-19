import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { downloadCloudOutput } from "@glintai/media";
import { requireExecution } from "./media-execution-store.mjs";

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};
const kinds = { image: ["png", "jpg", "webp"], video: ["mp4"], audio: ["mp3", "wav"] };
export function cloudOutputUrl(value, type) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1) return cloudOutputUrl(value[0], type);
  const candidate = value?.[type] ?? value?.images?.[0] ?? value?.audio ?? value?.output;
  if (typeof candidate === "string") return candidate;
  requireExecution(typeof candidate?.url === "string", "unsupported-output", 422);
  return candidate.url;
}
export async function importCloudOutput({
  root,
  task,
  writer,
  asset,
  probe,
  signal,
  download = downloadCloudOutput,
}) {
  const result = await download(task.resultUrl, signal);
  const extension = extensions[result.contentType];
  requireExecution(
    kinds[task.type].includes(extension) && result.bytes?.length > 0,
    "unsupported-output",
    422,
  );
  const sha256 = createHash("sha256").update(result.bytes).digest("hex");
  const name = `${task.taskId}.${extension}`,
    temporary = path.join(root, `.cloud-${randomUUID()}.part`);
  try {
    await fs.writeFile(temporary, result.bytes, { flag: "wx", mode: 0o600 });
    requireExecution(!probe(temporary, task.type), "output-decode-failed", 422);
    signal?.throwIfAborted();
    if (!asset(name)) writer.install(temporary, name);
    const installed = asset(name);
    requireExecution(
      installed &&
        createHash("sha256")
          .update(await fs.readFile(installed))
          .digest("hex") === sha256,
      "output-changed",
      409,
    );
    return { asset: name, sha256 };
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
