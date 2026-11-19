import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "./parse";
import { inspectChapterBundle, restoreChapterBundle, writeChapterBundle } from "./chapter-bundle";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapters-")); roots.push(root);
  const chapters = ["chapter-one", "chapter-two"].map(id => {
    const dir = path.join(root, id); fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "hero.png"), "same-hero");
    fs.writeFileSync(path.join(dir, "assets", "room.png"), "same-room");
    const project = parseProject({ schemaVersion: 1, id, title: id, aspect: "16:9", knowledgeSources: [], assets: [
      { id: "hero", kind: "character", name: "小雨", version: "v1", refs: ["assets/hero.png"] },
      { id: "room", kind: "location", name: "客厅", version: "v1", refs: ["assets/room.png"] },
    ], scenes: [{ id: "shot", kind: "image", src: "assets/room.png", assetRefs: [{ assetId: "hero", version: "v1" }, { assetId: "room", version: "v1" }], narration: { text: "对白", durationMs: 1000 } }] });
    const file = path.join(dir, "project.json"); fs.writeFileSync(file, JSON.stringify(project));
    return { project, root: dir, file };
  });
  return { root, chapters };
}
it("packs and restores two chapters via the real CLI with shared bytes stored once", () => {
  const { root, chapters } = fixture(), bundle = path.join(root, "pack"), restored = path.join(root, "restored");
  const cli = path.resolve("apps/studio/scripts/glint.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: path.resolve("apps/studio"), encoding: "utf8", timeout: 30000 });
  expect(run("bundle-chapters", ...chapters.map(ch => `--project=${ch.file}`), `--out=${bundle}`)).toContain("2 个工程");
  const inspection = JSON.parse(run("inspect-chapters", `--dir=${bundle}`));
  expect(inspection).toMatchObject({ references: 4, uniqueAssets: 2, expandedBytes: 36, storedBytes: 18 });
  expect(inspection.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(["chapter-one", "chapter-two"]);
  expect(fs.readdirSync(path.join(bundle, "assets"))).toHaveLength(2);
  expect(run("restore-chapters", `--dir=${bundle}`, `--out=${restored}`)).toContain("2 个工程");
  for (const chapter of chapters) {
    expect(parseProject(JSON.parse(fs.readFileSync(path.join(restored, chapter.project.id, "project.json"), "utf8")))).toEqual(chapter.project);
    expect(fs.readFileSync(path.join(restored, chapter.project.id, "assets", "hero.png"), "utf8")).toBe("same-hero");
    expect(fs.readFileSync(path.join(restored, chapter.project.id, "assets", "room.png"), "utf8")).toBe("same-room");
  }
}, 60000);
it("rejects conflicting identity bytes and never overwrites an existing destination", () => {
  const { root, chapters } = fixture(), out = path.join(root, "out");
  fs.writeFileSync(path.join(chapters[1]!.root, "assets", "hero.png"), "different");
  expect(() => writeChapterBundle(chapters, out)).toThrow(/不一致/); expect(fs.existsSync(out)).toBe(false);
  fs.mkdirSync(out); fs.writeFileSync(path.join(out, "keep"), "untouched");
  expect(() => writeChapterBundle(chapters, out)).toThrow(/不会覆盖/);
  expect(fs.readFileSync(path.join(out, "keep"), "utf8")).toBe("untouched");
});
it("rejects altered blobs, forged paths, oversized claims and missing entries before creating output", () => {
  const { root, chapters } = fixture(), bundle = path.join(root, "pack"), out = path.join(root, "out");
  const manifest = writeChapterBundle(chapters, bundle), file = path.join(bundle, "chapters.json"), original = fs.readFileSync(file, "utf8");
  const blob = path.join(bundle, "assets", `${manifest.chapters[0]!.assets[0]!.sha256}.blob`); fs.writeFileSync(blob, "tampered");
  expect(() => inspectChapterBundle(bundle)).toThrow(/校验失败/);
  expect(() => restoreChapterBundle(bundle, out)).toThrow(/校验失败/); expect(fs.existsSync(out)).toBe(false);
  const changed = JSON.parse(original); changed.chapters[0].assets[0].path = "assets/../../escape.png"; fs.writeFileSync(file, JSON.stringify(changed));
  expect(() => restoreChapterBundle(bundle, out)).toThrow(/条目无效/); expect(fs.existsSync(out)).toBe(false);
  changed.chapters[0].assets[0].path = "assets/hero.png"; changed.chapters[0].assets[0].bytes = 300 * 1024 * 1024; fs.writeFileSync(file, JSON.stringify(changed));
  expect(() => restoreChapterBundle(bundle, out)).toThrow(/条目无效/); expect(fs.existsSync(out)).toBe(false);
  changed.chapters[0].assets = []; fs.writeFileSync(file, JSON.stringify(changed));
  expect(() => restoreChapterBundle(bundle, out)).toThrow(/不完整/); expect(fs.existsSync(out)).toBe(false);
});

it("migrates a larger multi-chapter project through the actual CLI without expanding duplicate media in the pack", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapters-large-")); roots.push(root);
  const shared = Buffer.alloc(1024 * 1024, 0x53);
  const chapters = Array.from({ length: 18 }, (_, index) => {
    const id = `chapter-${String(index + 1).padStart(2, "0")}`, dir = path.join(root, id), assets = path.join(dir, "assets");
    fs.mkdirSync(assets, { recursive: true });
    const unique = Buffer.alloc(4096, index + 1); fs.writeFileSync(path.join(assets, "shared.png"), shared); fs.writeFileSync(path.join(assets, "cover.png"), unique);
    const project = parseProject({ schemaVersion: 1, id, title: `第 ${index + 1} 章`, aspect: "16:9", knowledgeSources: [], assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", refs: ["assets/shared.png"] }],
      scenes: Array.from({ length: 20 }, (_, scene) => ({ id: `shot-${scene + 1}`, kind: "image", src: scene === 0 ? "assets/cover.png" : "assets/shared.png", assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: `第 ${scene + 1} 镜`, durationMs: 1000 } })) });
    const file = path.join(dir, "project.json"); fs.writeFileSync(file, JSON.stringify(project)); return { id, project, file, unique };
  });
  const cli = path.resolve("apps/studio/scripts/glint.ts"), bundle = path.join(root, "pack"), out = path.join(root, "restored");
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: path.resolve("apps/studio"), encoding: "utf8", timeout: 60000 });
  run("bundle-chapters", ...chapters.map(chapter => `--project=${chapter.file}`), `--out=${bundle}`);
  const summary = JSON.parse(run("inspect-chapters", `--dir=${bundle}`));
  expect(summary).toMatchObject({ references: 36, uniqueAssets: 19, expandedBytes: 18 * (shared.length + 4096), storedBytes: shared.length + 18 * 4096 });
  expect(summary.chapters).toHaveLength(18); expect(summary.chapters.every((chapter: { scenes: number }) => chapter.scenes === 20)).toBe(true);
  run("restore-chapters", `--dir=${bundle}`, `--out=${out}`);
  for (const chapter of chapters) {
    expect(parseProject(JSON.parse(fs.readFileSync(path.join(out, chapter.id, "project.json"), "utf8")))).toEqual(chapter.project);
    expect(fs.readFileSync(path.join(out, chapter.id, "assets", "shared.png")).equals(shared)).toBe(true);
    expect(fs.readFileSync(path.join(out, chapter.id, "assets", "cover.png")).equals(chapter.unique)).toBe(true);
  }
}, 120000);
it("rejects missing files and symlinked resource directories", () => {
  const { root, chapters } = fixture(), outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "hero.png"), "same-hero");
  fs.rmSync(path.join(chapters[0]!.root, "assets"), { recursive: true });
  expect(() => writeChapterBundle(chapters, path.join(root, "missing"))).toThrow();
  fs.symlinkSync(outside, path.join(chapters[0]!.root, "assets"), process.platform === "win32" ? "junction" : "dir");
  expect(() => writeChapterBundle(chapters, path.join(root, "linked"))).toThrow(/受控普通文件/);
  expect(fs.existsSync(path.join(root, "linked"))).toBe(false);
});


it("rejects portable case collisions before creating a package", () => {
  const { root, chapters } = fixture();
  const dir = chapters[0]!.root;
  if (process.platform !== "win32") fs.writeFileSync(path.join(dir, "assets", "HERO.png"), "another");
  chapters[0]!.project = parseProject({ ...chapters[0]!.project, scenes: [...chapters[0]!.project.scenes, { id: "other", kind: "image", src: "assets/HERO.png", narration: { text: "其他", durationMs: 1000 } }] });
  const out = path.join(root, "case-conflict");
  expect(() => writeChapterBundle(chapters, out)).toThrow(/大小写/); expect(fs.existsSync(out)).toBe(false);
});
it("cleans only its newly created output after a copy failure", () => {
  const { root, chapters } = fixture(), out = path.join(root, "partial");
  fs.writeFileSync(path.join(root, "keep"), "keep");
  const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("simulated copy error"); });
  try { expect(() => writeChapterBundle(chapters, out)).toThrow(/simulated copy error/); }
  finally { spy.mockRestore(); }
  expect(fs.existsSync(out)).toBe(false); expect(fs.readFileSync(path.join(root, "keep"), "utf8")).toBe("keep");
});
it("rejects expanded size claims before reading blobs or creating output", () => {
  const { root, chapters } = fixture(), bundle = path.join(root, "pack"), out = path.join(root, "too-large");
  const manifest = writeChapterBundle(chapters, bundle);
  const repeated = Array.from({ length: 6 }, (_, index) => ({ ...manifest.chapters[0], project: { ...manifest.chapters[0]!.project, id: `chapter-${index}` }, assets: manifest.chapters[0]!.assets.map(entry => ({ ...entry, bytes: 256 * 1024 * 1024 })) }));
  fs.writeFileSync(path.join(bundle, "chapters.json"), JSON.stringify({ version: 1, chapters: repeated }));
  expect(() => restoreChapterBundle(bundle, out)).toThrow(/展开资源超过限制/); expect(fs.existsSync(out)).toBe(false);
});


it("rejects duplicate, reserved or nested chapter IDs before creating output", () => {
  const { root, chapters } = fixture(), bundle = path.join(root, "pack"), out = path.join(root, "bad-ids");
  const manifest = writeChapterBundle(chapters, bundle), file = path.join(bundle, "chapters.json");
  const invalid = ["chapter-one", "con", "nested/part", "CHAPTER-ONE"];
  for (const id of invalid) {
    const tampered = structuredClone(manifest); tampered.chapters[1]!.project.id = id;
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(() => restoreChapterBundle(bundle, out)).toThrow(); expect(fs.existsSync(out)).toBe(false);
  }
});


it("checks approved reference content across chapters and rejects a forged approval snapshot", () => {
  const { root, chapters } = fixture();
  for (const chapter of chapters) {
    const hero = chapter.project.assets![0]!;
    chapter.project = parseProject({ ...chapter.project, assets: [{ ...hero, description: "蓝外套", voice: "voice-a", approval: { version: "v1", name: "小雨", description: "蓝外套", voice: "voice-a", refs: ["assets/hero.png"] } }, chapter.project.assets![1]] });
  }
  const pack = path.join(root, "pack"), out = path.join(root, "out");
  const manifest = writeChapterBundle(chapters, pack);
  const forged = structuredClone(manifest);
  forged.chapters[1]!.project.assets![0]!.approval!.refs = ["assets/room.png"];
  fs.writeFileSync(path.join(pack, "chapters.json"), JSON.stringify(forged));
  expect(() => restoreChapterBundle(pack, out)).toThrow(); expect(fs.existsSync(out)).toBe(false);
  fs.writeFileSync(path.join(chapters[1]!.root, "assets", "hero.png"), "changed-approved-reference");
  const second = path.join(root, "conflicting-approved");
  expect(() => writeChapterBundle(chapters, second)).toThrow(/不一致/); expect(fs.existsSync(second)).toBe(false);
});
