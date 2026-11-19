import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { THEME_NAMES } from "@glintai/design-tokens";
import { archiveTheme, listArchives, readArchive, restoreTheme, sampleCatalog } from "./style-catalog";

const roots: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-style-catalog-")); roots.push(dir); return dir; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const project = (theme: unknown) => ({ schemaVersion: 1, id: "sample", title: "项目", aspect: "16:9", fps: 30, knowledgeSources: [], theme, futureField: { preserved: true }, scenes: [{ id: "one", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 1000 } }] });
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

// The ten style samples are rendered locally (scripts/render-style-samples.mjs);
// this catalog check only runs against a prepared samples directory.
const samplesPrepared = fs.existsSync(path.resolve(__dirname, "../../../outputs/style-samples/manifest.json"));

it.skipIf(!samplesPrepared)("exposes the ten actual samples and distinguishes recorded and observed hashes", () => {
  const root = path.resolve(__dirname, "../../../outputs/style-samples");
  const entries = sampleCatalog(root);
  expect(entries.map(item => item.id)).toEqual([...THEME_NAMES]);
  expect(entries.every(item => item.status === "available")).toBe(true);
  expect(entries.some(item => item.integrity === "not-recorded")).toBe(true);
  expect(entries.every(item => item.video && fs.statSync(item.video).size > 0 && item.sha256?.length === 64)).toBe(true);
});

it("does not trust manifest paths or report missing, duplicate and changed files as valid", () => {
  const dir = tmp();
  write(path.join(dir, "manifest.json"), { entries: [{ id: "glint-dark", status: "done", output: "../../outside", sha256: "bad" }, { id: "glint-light", status: "done" }, { id: "glint-light", status: "done" }] });
  fs.writeFileSync(path.join(dir, "glint-dark.mp4"), "different"); write(path.join(dir, "glint-dark.project.json"), project("glint-dark"));
  const entries = sampleCatalog(dir);
  expect(entries[0]).toMatchObject({ status: "mismatch", integrity: "mismatch" });
  expect(entries[1]).toMatchObject({ status: "unavailable" });
  expect(entries[2]).toMatchObject({ status: "unavailable" });
});

it("rejects empty video, malformed project and a sample belonging to another theme", () => {
  const dir = tmp(), video = path.join(dir, "glint-dark.mp4"), sample = path.join(dir, "glint-dark.project.json");
  write(path.join(dir, "manifest.json"), { entries: [{ id: "glint-dark", status: "done" }] });
  fs.writeFileSync(video, ""); write(sample, project("glint-dark"));
  expect(sampleCatalog(dir)[0]).toMatchObject({ status: "unavailable" });
  fs.writeFileSync(video, "sample"); fs.writeFileSync(sample, "{");
  expect(sampleCatalog(dir)[0]).toMatchObject({ status: "unavailable" });
  write(sample, project("glint-light"));
  expect(sampleCatalog(dir)[0]).toMatchObject({ status: "unavailable" });
  write(sample, project("glint-dark"));
  expect(sampleCatalog(dir)[0]).toMatchObject({ status: "available", integrity: "not-recorded" });
});

it("archives and restores unknown versions without overwriting either source or future project fields", () => {
  const dir = tmp(), source = path.join(dir, "source.json"), out = path.join(dir, "restored.json");
  const theme = { colors: { bg: "#123456" }, glintStyleSnapshot: { name: "future", version: "37", captured: { extra: [1, 2] } } };
  write(source, project(theme));
  const before = fs.readFileSync(source, "utf8");
  const archive = archiveTheme(source, path.join(dir, "history"));
  expect(readArchive(archive).payload.theme).toEqual(theme);
  expect(listArchives(path.join(dir, "history"), "sample")).toHaveLength(1);
  write(source, project("blueprint"));
  restoreTheme(source, archive, out);
  expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({ theme, futureField: { preserved: true } });
  expect(JSON.parse(fs.readFileSync(source, "utf8")).theme).toBe("blueprint");
  expect(() => restoreTheme(source, archive, out)).toThrow();
  expect(JSON.parse(before).theme).toEqual(theme);
});

it("preserves absent theme, rejects tampering and cross-project restore, and reveals corrupt history", () => {
  const dir = tmp(), source = path.join(dir, "source.json"), history = path.join(dir, "history");
  const original = project(undefined); delete original.theme; write(source, original);
  const archive = archiveTheme(source, history);
  write(source, project("glint-dark"));
  const output = path.join(dir, "output.json"); restoreTheme(source, archive, output);
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(output, "utf8")), "theme")).toBe(false);
  write(source, { ...project("glint-dark"), id: "different" });
  expect(() => restoreTheme(source, archive, path.join(dir, "bad.json"))).toThrow(/ID/);
  const changed = JSON.parse(fs.readFileSync(archive, "utf8")); changed.payload.theme = "tampered"; write(archive, changed);
  expect(() => readArchive(archive)).toThrow(/校验失败/);
  expect(listArchives(history, "sample")).toMatchObject([{ status: "invalid" }]);
  expect(fs.existsSync(path.join(dir, "bad.json"))).toBe(false);
});

it("runs archive, list and restore through the CLI without overwriting input", () => {
  const dir = tmp(), source = path.join(dir, "source.json"), history = path.join(dir, "history"), out = path.join(dir, "restored.json");
  const entry = path.resolve(__dirname, "glint.ts"), cwd = path.resolve(__dirname, "..");
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, "style-catalog", ...args], { cwd, encoding: "utf8", timeout: 30000 });
  write(source, project("glint-dark"));
  const saved = cli("archive", `--project=${source}`, `--dir=${history}`);
  expect(saved.status, saved.stderr).toBe(0);
  const archive = saved.stdout.trim();
  const listed = cli("list", `--dir=${history}`, "--id=sample");
  expect(listed.status, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject([{ status: "valid", theme: "glint-dark" }]);
  write(source, project("blueprint"));
  const before = fs.readFileSync(source);
  const restored = cli("restore", `--project=${source}`, `--source=${archive}`, `--out=${out}`);
  expect(restored.status, restored.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(out, "utf8")).theme).toBe("glint-dark");
  expect(fs.readFileSync(source)).toEqual(before);
  const collision = cli("restore", `--project=${source}`, `--source=${archive}`, `--out=${source}`);
  expect(collision.status).not.toBe(0);
  expect(fs.readFileSync(source)).toEqual(before);
});

it("rejects non-regular sample files and archive links", () => {
  const dir = tmp(), video = path.join(dir, "glint-dark.mp4"), source = path.join(dir, "source.json");
  write(path.join(dir, "manifest.json"), { entries: [{ id: "glint-dark", status: "done" }] });
  fs.writeFileSync(video, "sample"); write(path.join(dir, "glint-dark.project.json"), project("glint-dark")); write(source, project("glint-dark"));
  const archive = archiveTheme(source, path.join(dir, "history"));
  const original = fs.lstatSync;
  const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((file: any, ...args: any[]) => {
    if (String(file) === video || String(file) === archive) return { isFile: () => false } as any;
    return (original as any)(file, ...args);
  }) as any);
  try {
    expect(sampleCatalog(dir)[0]).toMatchObject({ status: "unavailable" });
    expect(() => readArchive(archive)).toThrow(/不可用/);
  } finally { spy.mockRestore(); }
});

it("runs the real CLI catalog entry", () => {
  const entry = path.resolve(__dirname, "glint.ts"), dir = tmp();
  write(path.join(dir, "manifest.json"), { entries: THEME_NAMES.map(id => ({ id, status: "done" })) });
  for (const id of THEME_NAMES) {
    fs.writeFileSync(path.join(dir, `${id}.mp4`), "isolated sample bytes");
    write(path.join(dir, `${id}.project.json`), project(id));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", entry, "style-catalog", "samples", `--dir=${dir}`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).entries).toHaveLength(10);
  expect(JSON.parse(result.stdout).entries.every((item: { status: string }) => item.status === "available")).toBe(true);
});
