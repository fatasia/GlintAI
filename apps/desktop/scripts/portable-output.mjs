import fs from "node:fs";
import path from "node:path";

/** A packaging run must never overwrite an existing package or archive. */
export function createPortableOutput(directory, archive) {
  const output = path.resolve(directory);
  if (archive) {
    const target = path.resolve(archive);
    const relative = path.relative(output, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Archive must be outside the package output directory");
    if (fs.existsSync(target)) throw new Error(`Archive already exists; choose a new path: ${target}`);
  }
  if (fs.existsSync(output)) throw new Error(`Package output already exists; choose a new path: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Non-recursive creation also closes the existence-check race.
  fs.mkdirSync(output);
  return output;
}
