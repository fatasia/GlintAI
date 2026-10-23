import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assetFingerprint, sceneMediaFingerprint, visualSceneIdentity, cacheArtifactValid, recordCacheArtifact } from "./native-cache";
import { parseProject, beatPulseScale } from "@glintai/scenescript";
import { CAPABILITIES, listInspiration, instantiateInspiration } from "./capability-catalog";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "glint-cache-test-"));
describe("scene cache correctness", () => {
  it("invalidates on asset bytes even when paths stay identical", () => {
    const root = temp();
    try {
      fs.mkdirSync(path.join(root, "assets")); const file = path.join(root, "assets", "a.png"); fs.writeFileSync(file, "old");
      const a = assetFingerprint(root); fs.writeFileSync(file, "new"); expect(assetFingerprint(root)).not.toBe(a);
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
