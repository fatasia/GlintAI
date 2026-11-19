import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createModelRegistryStore } from "./model-registry-store.mjs";
const roots: string[] = [];
const registry = {
  models: [
    {
      id: "test-image",
      name: "Fixture",
      provider: "fixture",
      kind: "image",
      capabilities: [],
      pricing: { basis: "unknown" },
      adapter: { type: "skills-gateway", model: "fixture-original" },
    },
  ],
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-registry-"));
  roots.push(root);
  const file = path.join(root, "settings", "model-registry.json");
  return { root, file, store: createModelRegistryStore(file) };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it("persists only declared registry data, restores after restart and refuses stale replacement", async () => {
  const { file, store } = fixture();
  const before = await store.read();
  expect(fs.existsSync(path.dirname(file))).toBe(false);
  const saved = await store.replace(registry, before.digest);
  expect(saved.models[0].adapter.model).toBe("fixture-original");
  expect(await createModelRegistryStore(file).read()).toEqual(saved);
  await expect(store.replace({ models: [] }, before.digest)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await store.read()).toEqual(saved);
});
it("invalid or secret imports preserve original bytes; corrupt records cannot be overwritten", async () => {
  const { file, store } = fixture();
  const saved = await store.replace(registry, (await store.read()).digest);
  const bytes = fs.readFileSync(file);
  await expect(
    store.replace(
      { models: [{ ...registry.models[0], notes: "Bearer fixture-private" }] },
      saved.digest,
    ),
  ).rejects.toMatchObject({ code: "secret" });
  expect(fs.readFileSync(file)).toEqual(bytes);
  fs.writeFileSync(file, "broken");
  await expect(store.read()).rejects.toMatchObject({ code: "stored-invalid" });
  await expect(store.replace(registry, saved.digest)).rejects.toMatchObject({
    code: "stored-invalid",
  });
  expect(fs.readFileSync(file, "utf8")).toBe("broken");
});
it("refuses linked ancestors and replaced roots, and never removes someone else's lock", async () => {
  const { root, file, store } = fixture();
  await store.replace(registry, (await store.read()).digest);
  fs.renameSync(path.dirname(file), path.join(root, "old"));
  fs.mkdirSync(path.dirname(file));
  await expect(store.read()).rejects.toMatchObject({ code: "unsafe-path" });
  fs.rmdirSync(path.dirname(file));
  fs.symlinkSync(path.join(root, "old"), path.dirname(file), "junction");
  await expect(createModelRegistryStore(file).read()).rejects.toMatchObject({
    code: "unsafe-path",
  });
  fs.unlinkSync(path.dirname(file));
  fs.renameSync(path.join(root, "old"), path.dirname(file));
  const other = createModelRegistryStore(file),
    current = await other.read();
  fs.writeFileSync(file + ".lock", "other writer");
  await expect(other.replace(registry, current.digest)).rejects.toMatchObject({ code: "busy" });
  expect(fs.readFileSync(file + ".lock", "utf8")).toBe("other writer");
});
function child(file: string, digest: string, id: string): Promise<string> {
  const require = createRequire(import.meta.url),
    loader = pathToFileURL(require.resolve("tsx/esm")).href;
  const module = pathToFileURL(path.resolve("apps/web/server/model-registry-store.mjs")).href;
  const code = `import {createModelRegistryStore} from ${JSON.stringify(module)};try{await createModelRegistryStore(${JSON.stringify(file)}).replace(${JSON.stringify({ models: [{ ...registry.models[0], id }] })},${JSON.stringify(digest)});console.log("saved")}catch(e){console.log(e.code)}`;
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      ["--import", loader, "--input-type=module", "-e", code],
      { windowsHide: true },
    );
    let output = "";
    process.stdout.on("data", (chunk) => {
      output += chunk;
    });
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error("Fixture child failed")),
    );
  });
}
it("serializes two real processes using the same CAS and fixed lock", async () => {
  const { file, store } = fixture();
  const initial = await store.read();
  const results = await Promise.all([
    child(file, initial.digest, "first"),
    child(file, initial.digest, "second"),
  ]);
  expect(results.filter((value) => value === "saved")).toHaveLength(1);
  expect(results.some((value) => ["busy", "conflict"].includes(value))).toBe(true);
  expect((await store.read()).models).toHaveLength(1);
  expect(fs.existsSync(file + ".lock")).toBe(false);
});

it("keeps old bytes and cleans owned temporary files when atomic publication fails", async () => {
  const { file, store } = fixture();
  const saved = await store.replace(registry, (await store.read()).digest);
  const before = fs.readFileSync(file);
  vi.spyOn(fs.promises, "rename").mockRejectedValue(
    Object.assign(new Error("fixture failure"), { code: "EACCES" }),
  );
  syncBuiltinESMExports();
  await expect(store.replace({ models: [] }, saved.digest)).rejects.toThrow("fixture failure");
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(path.dirname(file))).toEqual(["model-registry.json"]);
});
it("rejects linked records and refuses overlarge serialized metadata without overwriting", async () => {
  const { root, file, store } = fixture();
  const before = await store.replace(registry, (await store.read()).digest);
  const original = path.join(root, "original.json");
  fs.renameSync(file, original);
  fs.linkSync(original, file);
  await expect(store.read()).rejects.toMatchObject({ code: "stored-invalid" });
  expect(fs.readFileSync(original)).toEqual(fs.readFileSync(file));
  fs.unlinkSync(file);
  fs.renameSync(original, file);
  const models = Array.from({ length: 500 }, (_, index) => ({
    ...registry.models[0],
    id: `model-${index}`,
    notes: "��".repeat(400),
  }));
  await expect(store.replace({ models }, before.digest)).rejects.toMatchObject({
    code: "too-large",
  });
  expect((await store.read()).digest).toBe(before.digest);
});

it("does not unlink a replacement lock it no longer owns", async () => {
  const { file, store } = fixture();
  const saved = await store.replace(registry, (await store.read()).digest);
  const before = fs.readFileSync(file);
  vi.spyOn(fs.promises, "rename").mockImplementation(async () => {
    fs.renameSync(file + ".lock", file + ".old-lock");
    fs.writeFileSync(file + ".lock", "replacement owner");
    throw new Error("fixture publication blocked");
  });
  syncBuiltinESMExports();
  await expect(store.replace({ models: [] }, saved.digest)).rejects.toMatchObject({
    code: "unsafe-path",
  });
  expect(fs.readFileSync(file + ".lock", "utf8")).toBe("replacement owner");
  expect(fs.readFileSync(file)).toEqual(before);
});
