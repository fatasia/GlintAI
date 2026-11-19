import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseProjectContainer } from "@glintai/scenescript/project-container";
import { migrateProjectDirectory, runProjectMigration } from "./project-container-io";

let root: string;
const scene = { schemaVersion: 1, id: "old-id", title: "旧工程", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "shot", kind: "image", src: "assets/picture.png", narration: { text: "保持内容", durationMs: 1000 } }], customNotes: { text: "未知字段不能丢" } };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "glint-container-io-")); await fs.mkdir(path.join(root, "assets")); await fs.writeFile(path.join(root, "assets/picture.png"), Buffer.from([1, 2, 3, 4])); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function input(value: unknown = scene) { const source = path.join(root, "source.json"); await fs.writeFile(source, "\uFEFF" + JSON.stringify(value, null, 2) + "\r\n"); return source; }

it("preserves exact source bytes, unknown fields and copied assets, then validates the published container", async () => {
  const source = await input(), before = await fs.readFile(source), out = path.join(root, "new");
  const receipt = await migrateProjectDirectory({ source, out, kind: "scene-document" });
  expect(await fs.readFile(source)).toEqual(before);
  expect(await fs.readFile(path.join(out, "original.json"))).toEqual(before);
  expect(await fs.readFile(path.join(out, "assets/picture.png"))).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(receipt.assets).toHaveLength(1); expect(receipt.state).toBe("complete");
  expect(JSON.parse(await fs.readFile(path.join(out, "migration.json"), "utf8"))).toEqual(receipt);
  const container = await parseProjectContainer(JSON.parse(await fs.readFile(path.join(out, "project.json"), "utf8")));
  expect(container.versions[0]!.archive!.original).toEqual(scene);
  expect(container.versions[0]!.payload).toMatchObject({ id: "old-id", scenes: [{ id: "shot" }] });
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow();
  expect(await fs.readFile(path.join(out, "original.json"))).toEqual(before);
});

it("preserves timeline IDs, timings and trims", async () => {
  const timeline = { schemaVersion: 1, id: "timeline", title: "剪辑", fps: 30, width: 1920, height: 1080, tracks: [{ id: "video", kind: "video", name: "Track", clips: [{ id: "clip", kind: "video", src: "assets/picture.png", startMs: 1000, durationMs: 3000, trimStartMs: 400, speed: 1.5 }] }] };
  const source = await input(timeline), out = path.join(root, "timeline");
  await migrateProjectDirectory({ source, out, kind: "timeline-document" });
  const container = await parseProjectContainer(JSON.parse(await fs.readFile(path.join(out, "project.json"), "utf8")));
  expect(container.versions[0]!.payload).toMatchObject(timeline);
});

it("refuses missing or external assets before creating output", async () => {
  const source = await input(), out = path.join(root, "missing");
  await fs.unlink(path.join(root, "assets/picture.png"));
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow();
  await expect(fs.stat(out)).rejects.toThrow();
  await input({ ...scene, music: { src: "other.wav", volume: 0.3 } });
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow(/assets/);
  await expect(fs.stat(out)).rejects.toThrow();
});

it("refuses a symlinked asset directory without following it", async () => {
  const source = await input(), external = path.join(root, "external");
  await fs.rename(path.join(root, "assets"), external);
  await fs.symlink(external, path.join(root, "assets"), "junction");
  await expect(migrateProjectDirectory({ source, out: path.join(root, "blocked"), kind: "scene-document" })).rejects.toThrow(/regular files/);
});

it("does not publish completion when source changes during migration", async () => {
  const source = await input(), out = path.join(root, "changed"), copy = fs.copyFile.bind(fs);
  vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => { await copy(...args); await fs.appendFile(source, " "); });
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow(/changed/);
  await expect(fs.stat(path.join(out, "migration.json"))).rejects.toThrow();
  expect((await fs.readFile(path.join(out, "original.json"))).length).toBeLessThan((await fs.readFile(source)).length);
});

it("rejects malformed or duplicate CLI options without writing output", async () => {
  await expect(runProjectMigration(["--kind=scene-document", "--kind=timeline-document"])).rejects.toThrow();
  await expect(runProjectMigration(["--kind=unknown", `--project=${await input()}`, `--out=${path.join(root, "bad")}`])).rejects.toThrow();
  await expect(fs.stat(path.join(root, "bad"))).rejects.toThrow();
});

it("reaches migration through the actual CLI without a model", async () => {
  const source = await input(), out = path.join(root, "cli");
  const stdout = execFileSync(process.execPath, ["--import", "tsx", "scripts/glint.ts", "project-migrate", `--project=${source}`, `--out=${out}`, "--kind=scene-document"], { cwd: path.resolve("apps/studio"), encoding: "utf8", env: { ...process.env, GLINT_LLM_API_KEY: "" } });
  expect(JSON.parse(stdout).state).toBe("complete");
  expect(await fs.readFile(path.join(out, "original.json"))).toEqual(await fs.readFile(source));
});

it("does not mistake text or archived extensions for media references", async () => {
  const source = await input({ ...scene, title: "assets/not-a-file", customNotes: { src: "https://example.test/private", path: "assets/no-file" } });
  const result = await migrateProjectDirectory({ source, out: path.join(root, "text"), kind: "scene-document" });
  expect(result.assets.map(asset => asset.path)).toEqual(["assets/picture.png"]);
});

it("rejects invalid UTF-8 without silently changing text", async () => {
  const source = await input(), bytes = await fs.readFile(source), out = path.join(root, "utf8");
  const position = bytes.indexOf(Buffer.from("旧工程")); bytes[position] = 0xff; await fs.writeFile(source, bytes);
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow();
  await expect(fs.stat(out)).rejects.toThrow();
});

it("refuses glTF references until their transitive resources can be bundled", async () => {
  const source = await input({ ...scene, assets: [{ id: "model", kind: "character", name: "Model", version: "v1", refs: ["assets/model.gltf"] }] });
  const out = path.join(root, "gltf");
  await fs.writeFile(path.join(root, "assets/model.gltf"), JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "missing.bin", byteLength: 10 }] }));
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow(/glTF/);
  await expect(fs.stat(out)).rejects.toThrow();
});

it("does not publish completion when a valid container changes on disk", async () => {
  const source = await input(), out = path.join(root, "replaced"), write = fs.writeFile.bind(fs);
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (String(file).endsWith("project.json")) data = String(data).replace(/"project-[a-f0-9-]+"/, '"different-project"');
    return write(file, data, options);
  });
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow(/Container changed/);
  await expect(fs.stat(path.join(out, "migration.json"))).rejects.toThrow();
});

it("keeps source intact and publishes no completion file if manifest publication fails", async () => {
  const source = await input(), before = await fs.readFile(source), out = path.join(root, "publish-failed");
  vi.spyOn(fs, "link").mockRejectedValue(new Error("disk unavailable"));
  await expect(migrateProjectDirectory({ source, out, kind: "scene-document" })).rejects.toThrow("disk unavailable");
  await expect(fs.stat(path.join(out, "migration.json"))).rejects.toThrow();
  expect((await fs.readdir(out)).some(name => name.endsWith(".tmp"))).toBe(false);
  expect(await fs.readFile(source)).toEqual(before);
});
