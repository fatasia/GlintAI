import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyRuntimeDecoders, ensureDecoders, GLTF_DECODER_FILES, resolveRuntimeDecoder, RUNTIME_DECODERS,
} from "./decoders";

describe("copyRuntimeDecoders", () => {
  it("copies gsap.min.js byte-identical into the public root", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "glint-decoders-"));
    const copies = await copyRuntimeDecoders(temp), copied = copies[0];
    expect(copied?.file).toBe("gsap.min.js");
    expect(copied?.bytes).toBeGreaterThan(0);
    const source = resolveRuntimeDecoder("gsap/dist/gsap.min.js");
    const target = path.join(temp, "gsap.min.js");
    expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
    // Immutable source per installed version: a rerun overwrites safely.
    await expect(copyRuntimeDecoders(temp)).resolves.toEqual(copies);
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("creates a missing public directory and fails loudly on unknown files", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "glint-decoders-"));
    const nested = path.join(temp, "public");
    await copyRuntimeDecoders(nested);
    expect((await fs.readdir(nested)).sort()).toEqual([...RUNTIME_DECODERS.map((d) => d.file),"three.runtime.js"].sort());
    await fs.rm(temp, { recursive: true, force: true });
    expect(() => resolveRuntimeDecoder("gsap/dist/not-a-file.js")).toThrow(
      /not installed/,
    );
  });
});

async function tempPublic(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "glint-gltf-decoders-"));
}

function decoderPath(publicDir: string, file: string): string {
  return path.join(publicDir, ...file.split("/"));
}

describe("glTF decoder staging (ensureDecoders)", () => {
  it("copies the four three-package decoders into decoders/draco and decoders/basis", async () => {
    const publicDir = await tempPublic();
    const results = await ensureDecoders(publicDir);
    expect(results.map((result) => result.action)).toEqual(["copied", "copied", "copied", "copied"]);
    expect(results.map((result) => result.file)).toEqual([
      "decoders/draco/draco_decoder.wasm", "decoders/draco/draco_wasm_wrapper.js",
      "decoders/basis/basis_transcoder.js", "decoders/basis/basis_transcoder.wasm",
    ]);
    for (const { from, to } of GLTF_DECODER_FILES) {
      const source = resolveRuntimeDecoder(from);
      expect(source.replace(/\\/g, "/")).toContain("node_modules/three/examples/jsm/libs/");
      const copied = await fs.readFile(decoderPath(publicDir, to));
      expect(copied.equals(await fs.readFile(source))).toBe(true);
      expect(results.find((result) => result.file === to)?.bytes).toBe(copied.length);
    }
    // Real decoder payloads, not placeholders: WASM magic plus module entry points.
    for (const wasm of ["decoders/draco/draco_decoder.wasm", "decoders/basis/basis_transcoder.wasm"]) {
      expect([...(await fs.readFile(decoderPath(publicDir, wasm))).subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
    }
    expect(await fs.readFile(decoderPath(publicDir, "decoders/draco/draco_wasm_wrapper.js"), "utf8")).toContain("DracoDecoderModule");
    expect(await fs.readFile(decoderPath(publicDir, "decoders/basis/basis_transcoder.js"), "utf8")).toContain("WebAssembly");
    await fs.rm(publicDir, { recursive: true, force: true });
  });

  it("is idempotent: the second run keeps every file byte- and mtime-identical", async () => {
    const publicDir = await tempPublic();
    await ensureDecoders(publicDir);
    const before = new Map<string, { mtimeMs: number; size: number }>();
    for (const { to } of GLTF_DECODER_FILES) {
      const stat = await fs.stat(decoderPath(publicDir, to));
      before.set(to, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
    const second = await ensureDecoders(publicDir);
    expect(second.map((result) => result.action)).toEqual(["kept", "kept", "kept", "kept"]);
    for (const { to } of GLTF_DECODER_FILES) {
      const stat = await fs.stat(decoderPath(publicDir, to));
      expect(stat.mtimeMs).toBe(before.get(to)!.mtimeMs);
      expect(stat.size).toBe(before.get(to)!.size);
    }
    await fs.rm(publicDir, { recursive: true, force: true });
  });

  it("self-heals a drifted decoder file back to the three copy", async () => {
    const publicDir = await tempPublic();
    await ensureDecoders(publicDir);
    const drifted = decoderPath(publicDir, "decoders/basis/basis_transcoder.wasm");
    await fs.writeFile(drifted, "corrupted");
    const results = await ensureDecoders(publicDir);
    expect(results.find((result) => result.file === "decoders/basis/basis_transcoder.wasm")?.action).toBe("replaced");
    expect(results.filter((result) => result.action === "kept")).toHaveLength(3);
    const source = resolveRuntimeDecoder("three/examples/jsm/libs/basis/basis_transcoder.wasm");
    expect(await fs.readFile(drifted)).toEqual(await fs.readFile(source));
    await fs.rm(publicDir, { recursive: true, force: true });
  });

  it("fails with an actionable message when a decoder source is missing", () => {
    expect(() => resolveRuntimeDecoder("three/examples/jsm/libs/missing/decoder.wasm"))
      .toThrow(/not installed.*pnpm install/s);
  });
});
