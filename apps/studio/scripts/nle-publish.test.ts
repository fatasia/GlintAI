import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publishExclusive } from "./nle-publish";
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-publish-")); roots.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.writeFileSync(source, Buffer.alloc(150_000, 73));
  return { source, target };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
});
it("copies bounded chunks and preserves source bytes", async () => {
  const { source, target } = fixture();
  await publishExclusive(source, target);
  expect(fs.readFileSync(target)).toEqual(fs.readFileSync(source));
});
it("removes an owned partially written file after disk failure", async () => {
  const { source, target } = fixture(); const write = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementationOnce((fd, data, offset, length) => {
    if (!Buffer.isBuffer(data)) throw new Error("Expected binary chunk");
    write(fd, data, Number(offset), Math.min(Number(length), 17));
    expect(fs.statSync(target).size).toBe(17);
    throw new Error("injected ENOSPC after partial write");
  });
  await expect(publishExclusive(source, target)).rejects.toThrow("ENOSPC");
  expect(fs.existsSync(target)).toBe(false); expect(fs.statSync(source).size).toBe(150_000);
});
it("refuses existing targets without writing or removing them", async () => {
  const { source, target } = fixture(); fs.writeFileSync(target, "other-owner");
  const write = vi.spyOn(fs, "writeSync");
  await expect(publishExclusive(source, target)).rejects.toThrow("EEXIST");
  expect(write).not.toHaveBeenCalled(); expect(fs.readFileSync(target, "utf8")).toBe("other-owner");
});
it("aborts between chunks and removes only its partial copy", async () => {
  const { source, target } = fixture(); const controller = new AbortController(), write = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementationOnce((fd, data, offset, length) => {
    if (!Buffer.isBuffer(data)) throw new Error("Expected binary chunk");
    const n = write(fd, data, Number(offset), Number(length));
    controller.abort(); return n;
  });
  await expect(publishExclusive(source, target, controller.signal)).rejects.toThrow();
  expect(fs.existsSync(target)).toBe(false); expect(fs.statSync(source).size).toBe(150_000);
});
it("removes the owned empty target if the source cannot be opened", async () => {
  const { source, target } = fixture(); fs.unlinkSync(source);
  await expect(publishExclusive(source, target)).rejects.toThrow("ENOENT");
  expect(fs.existsSync(target)).toBe(false);
});
