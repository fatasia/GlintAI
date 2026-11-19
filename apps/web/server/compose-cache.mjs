import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const COMPOSE_CACHE_LIMIT = 200;

/** Only the fields that decide the composition result; a reused requestId with different content must 409, not return stale output. */
export function composeInputHash(body) {
  const relevant = {};
  for (const key of ["source", "idea", "plan", "template", "theme", "aspect", "engine"])
    if (body?.[key] !== undefined) relevant[key] = body[key];
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 16);
}

export function readComposeCache(dir, requestId, inputHash) {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, `${requestId}.json`), "utf8"));
    if (entry?.status !== "succeeded") return null;
    if (inputHash !== undefined && entry.inputHash !== inputHash) return { mismatch: true };
    return { body: entry.body };
  } catch {
    return null;
  }
}

export function writeComposeCache(dir, requestId, inputHash, body) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const stale of files.slice(0, Math.max(0, files.length + 1 - COMPOSE_CACHE_LIMIT)))
      fs.rmSync(stale.file, { force: true });
    fs.writeFileSync(
      path.join(dir, `${requestId}.json`),
      JSON.stringify({ status: "succeeded", inputHash, body, savedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch {
    /* Best-effort cache; the composition result still returns. */
  }
}
