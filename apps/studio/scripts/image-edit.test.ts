import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageEdit } from "./image-edit";

describe("non-destructive image edit chain", () => {
  it("refuses missing source, existing output and oversized inline images before spending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-edit-"));
    try {
      const env = { baseUrl: "https://media.example.invalid/v1", apiKey: "test" };
      await expect(imageEdit({ src: path.join(root, "missing.png"), prompt: "p", out: path.join(root, "o.png"), ...env })).rejects.toThrow(/not found/i);
      fs.writeFileSync(path.join(root, "a.png"), "img");
      fs.writeFileSync(path.join(root, "b.png"), "exists");
      await expect(imageEdit({ src: path.join(root, "a.png"), prompt: "p", out: path.join(root, "b.png"), ...env })).rejects.toThrow("already exists");
      fs.writeFileSync(path.join(root, "big.png"), Buffer.alloc(9 * 1024 * 1024));
      await expect(imageEdit({ src: path.join(root, "big.png"), prompt: "p", out: path.join(root, "c.png"), ...env })).rejects.toThrow("8 MiB");
      expect(fs.readdirSync(root).sort()).toEqual(["a.png", "b.png", "big.png"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
