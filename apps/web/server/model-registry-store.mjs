import fs from "node:fs/promises";
import path from "node:path";
import { builtinRegistry } from "@glintai/models";
import { atomicJson, readBounded, digest } from "./local-agent-common.mjs";
import { parseRegistryImport, REGISTRY_BYTES } from "../src/model-registry-data.ts";

const fail = (code, status = 400) => {
  throw Object.assign(new Error(code), { code, status });
};
async function guardPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) fail("unsafe-path", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function releaseOwnedLock(handle, lock) {
  const owned = await handle.stat();
  await handle.close();
  try {
    const current = await fs.lstat(lock);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino
    )
      fail("unsafe-path", 409);
    await fs.unlink(lock);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
/** Fixed file, shared wx lock and CAS. External/manual writers must honor the same lock. */
class ModelRegistryStore {
  constructor(file) {
    this.target = path.resolve(file);
    this.directory = path.dirname(this.target);
  }

  async guard(create = false) {
    await guardPath(this.target);
    if (create) await fs.mkdir(this.directory, { recursive: true });
    try {
      const stat = await fs.lstat(this.directory);
      const real = `${await fs.realpath(this.directory)}:${stat.dev}:${stat.ino}`;
      if (this.pinnedRoot && this.pinnedRoot !== real) fail("unsafe-path", 409);
      this.pinnedRoot = real;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async read() {
    await this.guard();
    let models = [];
    try {
      models = parseRegistryImport(JSON.stringify(await readBounded(this.target, REGISTRY_BYTES)));
    } catch (error) {
      if (error.code !== "ENOENT") fail("stored-invalid", 409);
    }
    return { models, builtins: [...builtinRegistry().entries], digest: digest({ models }) };
  }
  async replace(registry, baseDigest) {
    if (typeof baseDigest !== "string" || !/^[a-f0-9]{64}$/.test(baseDigest)) fail("invalid");
    const models = parseRegistryImport(JSON.stringify(registry));
    parseRegistryImport(JSON.stringify({ models }));
    await this.guard(true);
    const lock = `${this.target}.lock`;
    let handle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") fail("busy", 409);
      throw error;
    }
    try {
      if ((await this.read()).digest !== baseDigest) fail("conflict", 409);
      await this.guard();
      await atomicJson(this.target, { models });
      return await this.read();
    } finally {
      await releaseOwnedLock(handle, lock);
    }
  }
}
export function createModelRegistryStore(file) {
  return new ModelRegistryStore(file);
}
