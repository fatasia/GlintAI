import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateProject } from "./migrate";
import { openBundle, planBundle, referencedAssets, writeBundle } from "./bundle";
import type { SceneScriptProject } from "./types";

const v1Project = (): SceneScriptProject => ({
  schemaVersion: 1, id: "mig-demo", title: "当前版本", aspect: "16:9", fps: 30, knowledgeSources: [],
  scenes: [{ id: "s1", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 2000 } }],
} as SceneScriptProject);

describe("CORE-06 migration", () => {
  it("passes a current-version project through untouched", () => {
    const result = migrateProject(v1Project());
    expect(result.migrated).toBe(false);
    expect(result.project.id).toBe("mig-demo");
  });
  it("repairs a pre-version document with recorded notes instead of refusing", () => {
    const legacy = JSON.parse(fs.readFileSync(new URL("../fixtures/legacy-v0.json", import.meta.url), "utf8"));
    const result = migrateProject(legacy);
    expect(result.migrated).toBe(true);
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.scenes[0]!.narration.durationMs).toBeGreaterThan(0);
    expect(result.notes.join("\n")).toContain("schemaVersion 缺失");
  });
  it("refuses a future version instead of silently downgrading", () => {
    expect(() => migrateProject({ ...v1Project(), schemaVersion: 2 })).toThrow(/更新版本的 Glint/);
  });
});

describe("CORE-12 resource bundle", () => {
  it("collects referenced asset paths and reports missing ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bundle-"));
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "a.png"), "AA");
    const project = {
      ...v1Project(),
      scenes: [{ id: "s1", kind: "image", src: "assets/a.png", caption: "存在", narration: { text: "n", durationMs: 1000 } }, { id: "s2", kind: "image", src: "assets/gone.png", caption: "缺失", narration: { text: "n2", durationMs: 1000 } }],
    } as unknown as SceneScriptProject;
    expect(referencedAssets(project)).toEqual(["assets/a.png", "assets/gone.png"]);
    const plan = planBundle(project, dir);
    expect(plan.manifest.assets[0]).toMatchObject({ path: "assets/a.png", bytes: 2 });
    expect(plan.missingAssets).toEqual(["assets/gone.png"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("writes a bundle directory and reopens it with hash verification", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bundle-src-"));
    const out = path.join(dir, "bundle");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "a.png"), "AA");
    const project = { ...v1Project(), scenes: [{ id: "s1", kind: "image", src: "assets/a.png", narration: { text: "n", durationMs: 1000 } }] } as unknown as SceneScriptProject;
    writeBundle(project, dir, out);
    expect(() => writeBundle(project, dir, out)).toThrow(/已存在/);
    const reopened = openBundle(out);
    expect(reopened.project.id).toBe("mig-demo");
    expect(reopened.missingAssets).toEqual([]);
    expect(reopened.hashMismatches).toEqual([]);
    // Tamper detection: flip a byte and the hash must flag it.
    fs.writeFileSync(path.join(out, "assets", "a.png"), "AB");
    expect(openBundle(out).hashMismatches).toEqual(["assets/a.png"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("refuses to bundle or reopen assets that escape the project via symlinks or traversal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bundle-esc-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bundle-out-"));
    fs.writeFileSync(path.join(outside, "secret.png"), "SECRET");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    try { fs.symlinkSync(path.join(outside, "secret.png"), path.join(dir, "assets", "link.png"), "file"); }
    catch { // Windows without symlink privilege: a junction on a dir is the same escape primitive.
      fs.mkdirSync(path.join(outside, "escapedir"), { recursive: true });
      fs.symlinkSync(path.join(outside, "escapedir"), path.join(dir, "assets", "link.png"), "junction");
    }
    const project = { ...v1Project(), scenes: [{ id: "s1", kind: "image", src: "assets/link.png", narration: { text: "n", durationMs: 1000 } }] } as unknown as SceneScriptProject;
    const plan = planBundle(project, dir);
    expect(plan.missingAssets).toEqual(["assets/link.png"]);
    // A tampered manifest pointing outside the bundle dir is a mismatch, never a read.
    const out = path.join(dir, "bundle");
    writeBundle({ ...v1Project() }, dir, out);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    manifest.assets = [{ path: "../escape.png", sha256: null, bytes: null }];
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
    const reopened = openBundle(out);
    expect(reopened.hashMismatches).toEqual(["../escape.png"]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
