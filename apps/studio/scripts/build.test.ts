import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applyChange, applyProjectChanges, buildProject, planProject, saveManifest, loadManifest, projectSha256, verifyReceipt, provenanceForScene } from "./build";
import { parseProject } from "@glintai/scenescript";
import { createManifest } from "@glintai/buildgraph";

const roots: string[] = [];
function tempProject(extra: Partial<Record<string, unknown>> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-build-test-"));
  roots.push(root);
  const project = {
    schemaVersion: 1, id: "plan-fixture", title: "Plan fixture", aspect: "16:9", fps: 30,
    knowledgeSources: [],
    scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "hello", durationMs: 400 } }],
    ...extra,
  };
  const file = path.join(root, "project.json");
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
  return file;
}

afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("applyChange", () => {
  it("sets nested fields and array items with parsed JSON values", () => {
    const value = { scenes: [{ title: "a", count: 1 }] };
    applyChange(value, "scenes[0].title=\"b\"");
    applyChange(value, "scenes.0.count=2");
    expect(value.scenes[0]).toEqual({ title: "b", count: 2 });
  });
  it("refuses a missing path instead of creating it", () => {
    expect(() => applyChange({ a: 1 }, "b.c=2")).toThrow(/not found/);
  });
  it("rejects malformed expressions", () => {
    expect(() => applyChange({}, "novalue")).toThrow(/path=value/);
    expect(() => applyChange({}, "=x")).toThrow(/path=value/);
  });
});

describe("change budget", () => {
  it("lists every node on a first build", () => {
    const report = planProject({ projectPath: tempProject() });
    expect(report.plan.predicted).toEqual(["scene:one", "audio:mix", "container"]);
    expect(report.exact).toBe(true);
    expect(report.plan.costCny).toBe(0);
  });
  it("keeps the scene node clean when nothing changed", () => {
    const projectPath = tempProject();
    const first = planProject({ projectPath });
    saveManifest(projectPath, createManifest(first.plan, first.environment));
    expect(loadManifest(projectPath)?.version).toBe(1);
    const second = planProject({ projectPath });
    expect(second.plan.changed).toEqual([]);
    expect(second.plan.forced).toContain("audio:mix");
  });
  it("marks a changed scene and its dependents, and only those", () => {
    const projectPath = tempProject();
    const first = planProject({ projectPath });
    saveManifest(projectPath, createManifest(first.plan, first.environment));
    const changed = planProject({ projectPath, changes: ["scenes[0].title=\"Two\""] });
    expect(changed.plan.changed).toEqual(["scene:one", "container"]);
  });
  it("is not exact when narration duration is unknown", () => {
    const projectPath = tempProject({ scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "hello" } }] });
    const report = planProject({ projectPath });
    expect(report.exact).toBe(false);
    expect(report.notes.join(" ")).toMatch(/durationMs/);
  });
});

describe("apply command", () => {
  it("writes the change and returns a new revision", () => {
    const projectPath = tempProject();
    const before = projectSha256(parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8"))));
    const result = applyProjectChanges({ projectPath, changes: ["scenes[0].title=\"Two\""] });
    expect(result.revision).toBe(`sha256:${projectSha256(parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8"))))}`);
    expect(result.revision).not.toBe(`sha256:${before}`);
    expect(JSON.parse(fs.readFileSync(projectPath, "utf8")).scenes[0].title).toBe("Two");
  });
  it("rejects a stale expected revision", () => {
    const projectPath = tempProject();
    expect(() => applyProjectChanges({ projectPath, changes: ["scenes[0].title=\"X\""], expectedRevision: "sha256:stale" })).toThrow(/Revision conflict/);
  });
  it("rejects an invalid edit before writing", () => {
    const projectPath = tempProject();
    const original = fs.readFileSync(projectPath, "utf8");
    expect(() => applyProjectChanges({ projectPath, changes: ["scenes[0].kind=42"] })).toThrow();
    expect(fs.readFileSync(projectPath, "utf8")).toBe(original);
  });
});

describe("planBuild wiring", () => {
  it("uses the renderer cache key as the node digest", () => {
    const report = planProject({ projectPath: tempProject() });
    expect(report.plan.digests["scene:one"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasFfmpeg)("build end-to-end", () => {
  it("renders, writes a receipt and matches the predicted change set", async () => {
    const projectPath = tempProject();
    const output = path.join(path.dirname(projectPath), "out.mp4");
    const report = await buildProject({ projectPath, output, tts: "mock", music: "off", fast: true });
    expect(fs.existsSync(output)).toBe(true);
    expect(report.budget.matches).toBe(true);
    expect([...report.receipt.plan.predicted].sort()).toEqual([...report.receipt.plan.actual].sort());
    const receipt = JSON.parse(fs.readFileSync(`${output}.receipt.json`, "utf8"));
    expect(receipt.format).toBe("glint-receipt");
    const verified = await verifyReceipt({ receiptPath: `${output}.receipt.json` });
    expect(verified.pass).toBe(true);
    expect(verified.checks.find(check => check.name === "provenance-coverage")?.pass).toBe(true);
    expect(receipt.verification.find((entry: { law: string }) => entry.law === "L1")?.pass).toBe(true);
    expect(receipt.verification.find((entry: { law: string }) => entry.law === "L3")?.pass).toBe(true);
    expect(receipt.provenance.length).toBeGreaterThan(0);
    expect(receipt.provenance[0].origin).toBe("rendered");
    expect(receipt.output.frames).toBe(receipt.provenance.at(-1).frameRange[1] + 1);
  }, 120_000);

  it("reuses the cached scene on a second build", async () => {
    const projectPath = tempProject();
    const first = path.join(path.dirname(projectPath), "first.mp4");
    await buildProject({ projectPath, output: first, tts: "mock", music: "off", fast: true });
    const second = path.join(path.dirname(projectPath), "second.mp4");
    const report = await buildProject({ projectPath, output: second, tts: "mock", music: "off", fast: true });
    expect(report.receipt.totals.executed).toBe(2); // audio + container only
    expect(report.budget.matches).toBe(true);
  }, 180_000);
});

describe.skipIf(!hasFfmpeg)("container cache", () => {
  it("writes one container artifact per distinct cut", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-container-test-"));
    roots.push(root);
    const projectPath = path.join(root, "project.json");
    const unique = randomUUID().slice(0, 8);
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, id: `container-${unique}`, title: `Container ${unique}`, aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: `One ${unique}`, narration: { text: `x ${unique}`, durationMs: 200 } }] }, null, 2));
    const cacheDir = path.resolve(".cache", "native-container");
    // Other test workers publish into this shared cache concurrently; count only
    // artifacts byte-identical to our UUID-specific cut, not global directory growth.
    const output = path.join(root, "out.mp4");
    await buildProject({ projectPath, output, tts: "mock", music: "off", fast: true });
    const expected = fs.readFileSync(output);
    const matching = () => fs.readdirSync(cacheDir).filter(file => file.endsWith(".mp4") && fs.readFileSync(path.join(cacheDir, file)).equals(expected));
    const artifacts = matching();
    expect(artifacts).toHaveLength(1);
    const modified = fs.statSync(path.join(cacheDir, artifacts[0]!)).mtimeMs;
    await buildProject({ projectPath, output: path.join(root, "repeat.mp4"), tts: "mock", music: "off", fast: true });
    expect(matching()).toEqual(artifacts);
    expect(fs.statSync(path.join(cacheDir, artifacts[0]!)).mtimeMs).toBe(modified);
  }, 120_000);
});
describe("asset identity invalidation", () => {
  it("rebuilds only the scenes that pin a changed asset version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-asset-cache-test-"));
    roots.push(root);
    const projectPath = path.join(root, "project.json");
    const project = {
      schemaVersion: 1, id: "asset-cache", title: "Assets", aspect: "16:9", fps: 30, knowledgeSources: [],
      assets: [{ id: "hero", kind: "character", name: "主角", version: "v1" }, { id: "bottle", kind: "product", name: "商品", version: "v1" }],
      scenes: [
        { id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 }, assetRefs: [{ assetId: "hero", version: "v1" }] },
        { id: "two", kind: "title", title: "Two", narration: { text: "b", durationMs: 500 }, assetRefs: [{ assetId: "bottle", version: "v1" }] },
        { id: "three", kind: "title", title: "Three", narration: { text: "c", durationMs: 500 } },
      ],
    };
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    const first = planProject({ projectPath });
    saveManifest(projectPath, createManifest(first.plan, first.environment));
    project.assets[0]!.version = "v2";
    project.scenes[0]!.assetRefs![0]!.version = "v2";
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    const changed = planProject({ projectPath });
    expect(changed.plan.changed).toContain("scene:one");
    expect(changed.plan.changed).not.toContain("scene:two");
    expect(changed.plan.changed).not.toContain("scene:three");
    expect(changed.plan.changed).toContain("container");
  });
});

describe.skipIf(!hasFfmpeg)("NTSC timing", () => {
  it("renders 29.97 fps without frame drift", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ntsc-test-"));
    roots.push(root);
    const projectPath = path.join(root, "project.json");
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, id: "ntsc", title: "NTSC", aspect: "16:9", fps: 29.97, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "x", durationMs: 1001 } }] }, null, 2));
    const report = await buildProject({ projectPath, output: path.join(root, "out.mp4"), tts: "mock", music: "off", fast: true });
    expect(report.receipt.output?.frames).toBe(30);
    expect(report.receipt.verification.find(entry => entry.law === "L3")?.pass).toBe(true);
  }, 120_000);
});
describe("animation invalidation", () => {
  it("invalidates a scene when one of its keyframes changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-anim-test-"));
    roots.push(root);
    const projectPath = path.join(root, "project.json");
    const project = {
      schemaVersion: 1, id: "anim", title: "Anim", aspect: "16:9", fps: 30, knowledgeSources: [],
      scenes: [{
        id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 1000 },
        elements: [{ id: "price", kind: "text", text: "199", x: 0.5, y: 0.5 }],
        tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 500, value: 0.8 }] }],
      }],
    };
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    const first = planProject({ projectPath });
    saveManifest(projectPath, createManifest(first.plan, first.environment));
    project.scenes[0]!.tracks[0]!.keyframes[1]!.value = 0.9;
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
    const changed = planProject({ projectPath });
    expect(changed.plan.changed).toContain("scene:one");
    expect(changed.plan.changed).toContain("container");
  });
});
describe.skipIf(!hasFfmpeg)("cross-machine verification", () => {
  it("reports environment drift strictly but allows an explicit cross-machine check", async () => {
    const projectPath = tempProject();
    const output = path.join(path.dirname(projectPath), "cross.mp4");
    await buildProject({ projectPath, output, tts: "mock", music: "off", fast: true });
    const raw = JSON.parse(fs.readFileSync(`${output}.receipt.json`, "utf8"));
    raw.environment.resvg = "0.0.0-drifted";
    const drifted = `${output}.cross.receipt.json`;
    fs.writeFileSync(drifted, JSON.stringify(raw, null, 2));
    expect((await verifyReceipt({ receiptPath: drifted })).pass).toBe(false);
    expect((await verifyReceipt({ receiptPath: drifted, skipEnvironment: true })).pass).toBe(true);
  }, 120_000);
});
describe.skipIf(!hasFfmpeg)("audio cache", () => {
  it("reuses the content-addressed mix across builds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-audio-cache-test-"));
    roots.push(root);
    const unique = randomUUID().slice(0, 8);
    const projectPath = path.join(root, "project.json");
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, id: `audio-cache-${unique}`, title: `Audio ${unique}`, aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: `One ${unique}`, narration: { text: `a ${unique}`, durationMs: 400 } }] }, null, 2));
    const cacheDir = path.resolve(".cache", "native-audio");
    await buildProject({ projectPath, output: path.join(root, "a.mp4"), tts: "mock", music: "synth", fast: true });
    const afterFirst = fs.readdirSync(cacheDir).filter(file => file.endsWith(".wav")).length;
    await buildProject({ projectPath, output: path.join(root, "b.mp4"), tts: "mock", music: "synth", fast: true });
    const afterSecond = fs.readdirSync(cacheDir).filter(file => file.endsWith(".wav")).length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(afterFirst);
  }, 180_000);
});
describe("scene provenance", () => {
  const scene = (extra: Record<string, unknown>) => parseProject({
    schemaVersion: 1, id: "prov", title: "Prov", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "one", narration: { text: "a", durationMs: 500 }, ...extra }],
  }).scenes[0]!;
  it("defaults image/video to footage and other scenes to rendered", () => {
    expect(provenanceForScene(scene({ kind: "image", src: "assets/a.png" }), 0, 9)).toMatchObject({ origin: "footage", source: "assets/a.png" });
    expect(provenanceForScene(scene({ kind: "title", title: "x" }), 0, 9)).toMatchObject({ origin: "rendered" });
  });
  it("lets a scene declare generated source, model and seed", () => {
    const declared = scene({ kind: "image", src: "assets/a.png", provenance: { origin: "generated", source: "job/abc", model: "seedream", seed: 42 } });
    expect(provenanceForScene(declared, 10, 19)).toEqual({ frameRange: [10, 19], origin: "generated", source: "job/abc", model: "seedream", seed: 42 });
  });
});
describe.skipIf(!hasFfmpeg)("receipt L1 enforcement", () => {
  it("fails verification when the receipt records a budget mismatch", async () => {
    const projectPath = tempProject();
    const output = path.join(path.dirname(projectPath), "l1.mp4");
    await buildProject({ projectPath, output, tts: "mock", music: "off", fast: true });
    const raw = JSON.parse(fs.readFileSync(`${output}.receipt.json`, "utf8"));
    raw.plan.matches = false;
    raw.plan.missing = ["scene:one"];
    const path2 = `${output}.l1.receipt.json`;
    fs.writeFileSync(path2, JSON.stringify(raw, null, 2));
    const report = await verifyReceipt({ receiptPath: path2 });
    expect(report.pass).toBe(false);
    expect(report.checks.find(check => check.name === "plan-matches")?.pass).toBe(false);
  }, 120_000);
});