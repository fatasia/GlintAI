import { describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { makeCreationPack } from "./exported-packs";
import { materializeImportedPack, parseImportedPack } from "./imported-packs";

const metadata = { id: "my-recipe", title: "我的配方", description: "可编辑配方", author: "Ada", license: "仅供本人使用", packVersion: "2.3.4", tags: ["中文"] };
function fixture(): SceneScriptProject {
  return parseProject({
    schemaVersion: 1, id: "source-project", title: "Original", aspect: "16:9", knowledgeSources: [],
    creationPack: { id: "prior-recipe", version: "1.0.0" },
    scenes: [{
      id: "opening", kind: "title", title: "Hello", notes: "PRIVATE notes", narration: { text: "Explain", durationMs: 2000 },
      elements: [{ id: "rule", kind: "rect", x: 0.1, y: 0.8, w: 0.8, h: 0.01, fill: "#112233" }],
      tracks: [{ elementId: "rule", property: "scale", keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1, easing: "ease-out" }] }],
      effects: [{ id: "dim", kind: "brightness", value: 1 }], camera: { type: "push", intensity: 0.3 },
    }],
  });
}
function changed(path: string, value: unknown): SceneScriptProject {
  const project = fixture();
  const keys = path.split(".");
  let target = project as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return project;
}

describe("makeCreationPack", () => {
  it("roundtrips an edited project through the strict importer and new pinned instance without writes", () => {
    const project = fixture(), before = structuredClone(project), info = structuredClone(metadata);
    project.scenes[0]!.narration.text = "Edited explanation";
    before.scenes[0]!.narration.text = "Edited explanation";
    const pack = makeCreationPack(project, info);
    expect(pack).toMatchObject({ ...metadata, format: "glint-creation-pack", version: 1, permissions: [] });
    expect(pack.project.scenes[0]).not.toHaveProperty("notes");
    expect(pack.project.creationPack).toEqual({ id: "prior-recipe", version: "1.0.0" });
    expect(pack.project.scenes[0]).toMatchObject({ narration: { text: "Edited explanation" }, elements: project.scenes[0]!.elements, tracks: project.scenes[0]!.tracks, effects: project.scenes[0]!.effects, camera: project.scenes[0]!.camera });
    expect(parseImportedPack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
    const instance = materializeImportedPack(pack, { projectId: "new-project" });
    expect(instance.project.creationPack).toEqual({ id: metadata.id, version: metadata.packVersion });
    expect(instance.project.id).toBe("new-project");
    expect(instance.project.scenes[0]!.narration.text).toBe("Edited explanation");
    pack.tags.push("changed"); pack.project.scenes[0]!.narration.text = "Modified export";
    expect(project).toEqual(before); expect(info).toEqual(metadata);
    expect(instance.project.scenes[0]!.narration.text).toBe("Edited explanation");
  });

  it("is deterministic, defaults tags, and needs no browser, storage, crypto or network", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("must not fetch"); });
    try {
      const { tags: _, ...info } = metadata;
      expect(makeCreationPack(fixture(), info).tags).toEqual([]);
      expect(makeCreationPack(fixture(), info)).toEqual(makeCreationPack(fixture(), info));
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([
    ["assets", []], ["music", { src: "assets/music.mp3" }], ["sfx", []],
    ["knowledgeSources", [{ id: "external", kind: "markdown", name: "https://example.com" }]],
    ["theme", "https://example.com"], ["plugin", "execute"],
    ["scenes.0.kind", "image"], ["scenes.0.kind", "video"], ["scenes.0.kind", "html"], ["scenes.0.kind", "three"],
    ["scenes.0.src", "assets/image.png"], ["scenes.0.assetRefs", []], ["scenes.0.audioRef", "assets/audio.mp3"],
    ["scenes.0.narration.audioRef", "assets/voice.mp3"], ["scenes.0.narration.url", "https://example.com"],
    ["scenes.0.elements.0.src", "https://example.com"],
    ["scenes.0.id", "INVALID"], ["scenes.0.title", "x".repeat(4097)],
  ])("rejects %s rather than stripping content", (path, value) => {
    const project = changed(path as string, value), before = structuredClone(project);
    expect(() => makeCreationPack(project, metadata)).toThrow();
    expect(project).toEqual(before);
  });

  it.each([
    { id: "../escape" }, { title: " " }, { author: "" }, { license: "" }, { description: "x".repeat(1001) },
    { packVersion: "1.0" }, { packVersion: "01.0.0" }, { tags: ["same", "same"] },
  ])("applies importer metadata restrictions: %j", invalid => {
    expect(() => makeCreationPack(fixture(), { ...metadata, ...invalid })).toThrow();
  });

  it("defaults only omitted tags, not malformed null tags", () => {
    const malformed = { ...metadata, tags: null } as unknown as Parameters<typeof makeCreationPack>[1];
    expect(() => makeCreationPack(fixture(), malformed)).toThrow("tags");
  });

  it("rejects excessive scenes and non-JSON project accessors without running them", () => {
    const project = fixture(), getter = vi.fn(() => "not evaluated");
    Object.defineProperty(project.scenes[0], "title", { enumerable: true, get: getter });
    expect(() => makeCreationPack(project, metadata)).toThrow("accessors");
    expect(getter).not.toHaveBeenCalled();
    const many = fixture();
    many.scenes = Array.from({ length: 21 }, (_, i) => ({ ...many.scenes[0]!, id: `scene-${i}` }));
    expect(() => makeCreationPack(many, metadata)).toThrow("1–20");
  });
});
