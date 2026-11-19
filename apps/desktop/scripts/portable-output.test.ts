import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Module is plain JavaScript.
import { createPortableOutput } from "./portable-output.mjs";

it("creates a new output only and preserves existing packages and archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-portable-output-"));
  try {
    const output = path.join(root, "new", "package"), archive = path.join(root, "package.zip");
    expect(() => createPortableOutput(output, path.join(output, "package.zip"))).toThrow(/outside/);
    expect(fs.existsSync(output)).toBe(false);
    expect(createPortableOutput(output, archive)).toBe(output);
    fs.writeFileSync(path.join(output, "keep.txt"), "original");
    expect(() => createPortableOutput(output, archive)).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(output, "keep.txt"), "utf8")).toBe("original");
    fs.writeFileSync(archive, "original-archive");
    const other = path.join(root, "other");
    expect(() => createPortableOutput(other, archive)).toThrow(/Archive already exists/);
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.readFileSync(archive, "utf8")).toBe("original-archive");
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
