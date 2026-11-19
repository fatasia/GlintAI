import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function checkedPath(file: string): string {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("Linked recipe paths are not supported");
  }
  return absolute;
}
export function readLocal(file: string, limit = 512 * 1024): string {
  checkedPath(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Recipe input must be a bounded regular file");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
export function writeNew(file: string, text: string): void {
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function replaceJson(file: string, value: unknown): void {
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    writeNew(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export async function withRecipeLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const root = checkedPath(directory),
    lock = path.join(root, ".recipe.lock");
  const fd = fs.openSync(lock, "wx"),
    owned = fs.fstatSync(fd);
  try {
    return await action();
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(lock) && fs.lstatSync(lock).ino === owned.ino) fs.unlinkSync(lock);
  }
}
