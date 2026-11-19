import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript helper.
import { createPortableArchive } from "./portable-archive.mjs";

it.skipIf(process.platform !== "win32")("creates a ZIP without replacing existing files and fails on missing input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-archive-test-"));
  try {
    const source = path.join(root, "input's folder"), archive = path.join(root, "output's archive.zip");
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, "data.txt"), "glint");
    createPortableArchive(source, archive);
    const bytes = fs.readFileSync(archive);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
    expect(() => createPortableArchive(source, archive)).toThrow(/already exists/);
    expect(fs.readFileSync(archive)).toEqual(bytes);
    const missing = path.join(root, "missing"), other = path.join(root, "other.zip");
    expect(() => createPortableArchive(missing, other)).toThrow(/failed/);
    expect(fs.existsSync(other)).toBe(false);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("rejects a process that reports success without creating a ZIP", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-archive-empty-"));
  try { expect(() => createPortableArchive(root, path.join(root, "missing.zip"), () => ({ status: 0 }))).toThrow(/valid ZIP/); }
  finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
