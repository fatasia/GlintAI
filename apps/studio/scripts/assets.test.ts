import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { copyProjectAssets, PROJECT_ASSET_LIMITS } from "./assets";

const fixture = fileURLToPath(new URL("../../../examples/local-media/", import.meta.url));
let temp: string;
let project: SceneScriptProject;
let source: string;
let output: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "glint-assets-test-"));
  source = path.join(temp, "source"); output = path.join(temp, "public");
  await fs.cp(fixture, source, { recursive: true });
  project = parseProject(JSON.parse(await fs.readFile(path.join(source, "project.scenescript.json"), "utf8")));
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
const modelSrc = (p: SceneScriptProject) => (p.scenes[0] as { src: string }).src;
const targetFile = (p: SceneScriptProject) => path.join(output, modelSrc(p));

async function editModel(uri: string) {
  const file = path.join(source, "assets/models/cube.gltf");
  const document = JSON.parse(await fs.readFile(file, "utf8"));
  document.images[0].uri = uri;
  await fs.writeFile(file, JSON.stringify(document));
}

describe("copyProjectAssets", () => {
  it("recursively copies dependencies, preserves layout and rewrites a clone", async () => {
    project.music = { src: "assets/models/cube.bin" };
    project.scenes[0]!.narration.audioRef = "assets/models/cube.bin";
    project.scenes[1]!.narration.audioRef = "audio/generated.wav";
    const before = structuredClone(project);
    const prepared = await copyProjectAssets(source, output, project);
    expect(project).toEqual(before);
    expect(modelSrc(prepared)).toMatch(/^assets\/project-[^/]+\/models\/cube.gltf$/);
    expect(await fs.readFile(targetFile(prepared), "utf8")).toContain('"uri": "textures/checker.png"');
    const namespace = modelSrc(prepared).split("/").slice(0, 2).join("/");
    for (const name of ["cube.bin", "cube.glb", "textures/checker.png"]) {
      expect(await fs.readFile(path.join(output, namespace, "models", name))).toEqual(await fs.readFile(path.join(source, "assets/models", name)));
    }
    expect(prepared.music?.src).toBe(`${namespace}/models/cube.bin`);
    expect(prepared.scenes[0]?.narration.audioRef).toBe(prepared.music?.src);
    expect(prepared.scenes[1]?.narration.audioRef).toBe("audio/generated.wav");
    expect(parseProject(prepared)).toEqual(prepared);
  });
  it("isolates simultaneous copies even for identical project IDs", async () => {
    const results = await Promise.all([copyProjectAssets(source, output, project), copyProjectAssets(source, output, project)]);
    expect(modelSrc(results[0]!)).not.toBe(modelSrc(results[1]!));
    expect(await fs.readFile(targetFile(results[0]!))).toEqual(await fs.readFile(targetFile(results[1]!)));
  });
  it("allows no assets only when no project assets are referenced", async () => {
    await fs.rm(path.join(source, "assets"), { recursive: true });
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/missing/);
    project.scenes = [{ id: "title", kind: "title", title: "T", narration: { text: "T" } }];
    expect(await copyProjectAssets(source, output, project)).toEqual(project);
  });
  it("fails on missing scene files and missing glTF dependencies without partial output", async () => {
    await fs.unlink(path.join(source, "assets/models/cube.bin"));
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/resource is missing/);
    expect(await fs.readdir(path.join(output, "assets"))).toEqual([]);
    (project.scenes[0] as { src: string }).src = "assets/missing.glb";
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/asset is missing/);
  });
  it.each(["../outside.png", "https://host/texture.png", "/absolute.png", "%2e%2e/a", "textures/../../a"])("blocks model reference %s", async (uri) => {
    await editModel(uri);
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/Unsafe/);
    expect(await fs.readdir(path.join(output, "assets"))).toEqual([]);
  });
  it.each(["maxFileBytes", "maxTotalBytes", "maxFiles", "maxDepth"] as const)("enforces %s", async (limit) => {
    await expect(copyProjectAssets(source, output, project, { ...PROJECT_ASSET_LIMITS, [limit]: 1 })).rejects.toThrow(/exceed/i);
    expect(await fs.readdir(path.join(output, "assets"))).toEqual([]);
  });
  it("rejects destination nested inside source", async () => {
    await expect(copyProjectAssets(source, path.join(source, "assets/public"), project)).rejects.toThrow(/inside/);
  });
  it("rejects directory symlinks (junctions on Windows) in either tree", async () => {
    const outside = path.join(temp, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(source, "assets/escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/symlink/);
    await fs.rm(path.join(source, "assets/escape"));
    await fs.rm(output, { recursive: true, force: true });
    await fs.symlink(outside, output, process.platform === "win32" ? "junction" : "dir");
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow(/symlink/);
  });
  it("rejects unvalidated project paths before touching output", async () => {
    (project.scenes[0] as { src: string }).src = "assets/../outside.glb";
    await expect(copyProjectAssets(source, output, project)).rejects.toThrow();
    await expect(fs.access(output)).rejects.toThrow();
  });
});
