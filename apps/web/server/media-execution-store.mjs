import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, readBounded } from "./local-agent-common.mjs";
export function executionError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
export function requireExecution(ok, code, status = 400) {
  if (!ok) throw executionError(code, status);
}
async function guardAncestors(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      requireExecution(!(await fs.lstat(current)).isSymbolicLink(), "unsafe-path", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) return;
  }
}
async function release(handle, file) {
  const own = await handle.stat();
  await handle.close();
  const current = await fs.lstat(file);
  requireExecution(
    current.isFile() &&
      !current.isSymbolicLink() &&
      current.ino === own.ino &&
      current.dev === own.dev,
    "lock-replaced",
    409,
  );
  await fs.unlink(file);
}
/** Fixed local metadata only. Reuses existing bounded reads and atomic JSON publication. */
class ExecutionStore {
  constructor(file, initial, validate, limit) {
    Object.assign(this, { file: path.resolve(file), initial, validate, limit });
  }
  async guard(create = false) {
    const { file } = this;
    await guardAncestors(file);
    if (create) await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      const stat = await fs.lstat(path.dirname(file));
      const identity = `${await fs.realpath(path.dirname(file))}:${stat.dev}:${stat.ino}`;
      requireExecution(!this.pinned || this.pinned === identity, "root-changed", 409);
      this.pinned = identity;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async read() {
    await this.guard();
    try {
      return this.validate(await readBounded(this.file, this.limit));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(this.initial);
      throw executionError("stored-invalid", 409);
    }
  }
  async update(change) {
    await this.guard(true);
    let handle;
    try {
      handle = await fs.open(this.file + ".lock", "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw executionError("busy", 409);
      throw error;
    }
    try {
      const state = await this.read(),
        result = await change(state);
      this.validate(state);
      requireExecution(Buffer.byteLength(JSON.stringify(state)) <= this.limit, "store-full", 409);
      await this.guard();
      await atomicJson(this.file, state);
      return result;
    } finally {
      await release(handle, this.file + ".lock");
    }
  }
}
export function executionStore(file, initial, validate, limit = 4 * 1024 * 1024) {
  return new ExecutionStore(file, initial, validate, limit);
}
export function recordTable(value, field, maximum) {
  requireExecution(
    value?.version === 1 && Array.isArray(value[field]) && value[field].length <= maximum,
    "invalid-state",
  );
  return value;
}
export function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
