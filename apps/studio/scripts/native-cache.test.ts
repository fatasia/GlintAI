import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assetFingerprint, sceneMediaFingerprint, visualSceneIdentity, cacheArtifactValid, recordCacheArtifact, renderImplementationFingerprint, IMPLEMENTATION_FILES, fileContentIdentity } from "./native-cache";
import { PROJECT_ASSET_LIMITS } from "./assets";
import { parseProject, beatPulseScale } from "@glintai/scenescript";
import { CAPABILITIES, listInspiration, instantiateInspiration } from "./capability-catalog";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "glint-cache-test-"));
describe("scene cache correctness", () => {
  it("invalidates the renderer fingerprint when the shared element evaluator changes", () => {
    const root = temp(), scriptDir = path.join(root, "apps", "studio", "scripts");
    try {
      for (const relative of IMPLEMENTATION_FILES) {
        const file = path.resolve(scriptDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "first");
      }
      const before = renderImplementationFingerprint(scriptDir);
      fs.writeFileSync(path.join(root, "packages", "scenescript", "src", "elements.ts"), "changed");
      expect(renderImplementationFingerprint(scriptDir)).not.toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("invalidates on asset bytes even when paths stay identical", () => {
    const root = temp();
    try {
      fs.mkdirSync(path.join(root, "assets")); const file = path.join(root, "assets", "a.png"); fs.writeFileSync(file, "old");
      const a = assetFingerprint(root); fs.writeFileSync(file, "new"); expect(assetFingerprint(root)).not.toBe(a);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("does not use a constant fallback for incomplete source", () => {
    const root = temp();
    try { expect(renderImplementationFingerprint(root)).not.toBe(renderImplementationFingerprint(root)); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("hashes executable contents instead of metadata", () => {
    const root = temp(), file = path.join(root, "binary");
    try {
      fs.writeFileSync(file, "aaaa"); const time = new Date("2020-01-01"); fs.utimesSync(file, time, time);
      const before = fileContentIdentity(file); fs.writeFileSync(file, "bbbb"); fs.utimesSync(file, time, time);
      expect(fileContentIdentity(file)).not.toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects an assets root junction and oversized file before hashing", () => {
    const root = temp(), target = temp();
    try {
      fs.symlinkSync(target, path.join(root, "assets"), process.platform === "win32" ? "junction" : "dir");
      expect(() => assetFingerprint(root)).toThrow(/symlink/);
      fs.unlinkSync(path.join(root, "assets")); fs.mkdirSync(path.join(root, "assets"));
      const fd = fs.openSync(path.join(root, "assets", "large.bin"), "w");
      try { fs.ftruncateSync(fd, PROJECT_ASSET_LIMITS.maxFileBytes + 1); } finally { fs.closeSync(fd); }
      expect(() => assetFingerprint(root)).toThrow(/per-file byte limit/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
  });
  it("rejects excessive asset depth before hashing", () => {
    const root = temp();
    try {
      let dir = path.join(root, "assets"); fs.mkdirSync(dir);
      for (let i = 0; i <= PROJECT_ASSET_LIMITS.maxDepth; i++) { dir = path.join(dir, "x"); fs.mkdirSync(dir); }
      expect(() => assetFingerprint(root)).toThrow(/depth exceeds/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("enforces the copied asset entry count and total byte limits", () => {
    const root = temp(), dir = path.join(root, "assets");
    try {
      fs.mkdirSync(dir);
      for (let i = 0; i <= PROJECT_ASSET_LIMITS.maxFiles; i++) fs.writeFileSync(path.join(dir, `f${i}`), "");
      expect(() => assetFingerprint(root)).toThrow(/entry count/);
      fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir);
      for (let i = 0; i < 5; i++) {
        const fd = fs.openSync(path.join(dir, `large${i}`), "w");
        try { fs.ftruncateSync(fd, PROJECT_ASSET_LIMITS.maxFileBytes); } finally { fs.closeSync(fd); }
      }
      expect(() => assetFingerprint(root)).toThrow(/total byte limit/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("checks file hashes instead of accepting a large corrupted MP4", () => {
    const root = temp();
    try { const file = path.join(root, "clip.mp4"); fs.writeFileSync(file, "x".repeat(100)); expect(cacheArtifactValid(file)).toBe(false); recordCacheArtifact(file); expect(cacheArtifactValid(file)).toBe(true); fs.writeFileSync(file, "y".repeat(100)); expect(cacheArtifactValid(file)).toBe(false); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("does not let notes or a changing audio path invalidate equal pixels", () => {
    const scene = parseProject({ schemaVersion: 1, id: "x", title: "X", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "s", kind: "title", title: "X", notes: "private", narration: { text: "旁白", audioRef: "generated/random.mp3" } }] }).scenes[0]!;
    const copy = visualSceneIdentity(scene, true); expect(copy.notes).toBeUndefined(); expect(copy.narration.audioRef).toBeUndefined(); expect(scene.notes).toBe("private");
  });
});

describe("beat pulse", () => {
  it("has exact resting endpoints and bounded deterministic strength", () => {
    const pulse = { beatsMs: [100], durationMs: 200, amount: 0.05 };
    expect(beatPulseScale(undefined, 200)).toBe(1); expect(beatPulseScale(pulse, 50)).toBe(1); expect(beatPulseScale(pulse, 100)).toBe(1);
    expect(beatPulseScale(pulse, 150)).toBeGreaterThan(1); expect(beatPulseScale(pulse, 150)).toBeLessThanOrEqual(1.05); expect(beatPulseScale(pulse, 400)).toBe(1);
  });
});

describe("capability and inspiration discoverability", () => {
  it("lists cost and recovery on every executable capability", () => { expect(CAPABILITIES.every(c => c.input && c.output && c.cost && c.recovery)).toBe(true); });
  it("searches real recipes and copies a runnable project", () => {
    const root = temp();
    try { expect(listInspiration("Magic Move")[0]?.id).toBe("editable-data"); const target = path.join(root, "copy"); const result = instantiateInspiration("editable-data", target); expect(parseProject(JSON.parse(fs.readFileSync(result.projectPath, "utf8"))).scenes).toHaveLength(2); expect(() => instantiateInspiration("editable-data", target)).toThrow("already exists"); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
