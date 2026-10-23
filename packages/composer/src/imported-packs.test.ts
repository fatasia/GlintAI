import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { changeNarration, moveScene, parseEditorProject } from "../../../apps/web/src/editor-model";
import { listCreationPacks } from "./creation-packs";
import { IMPORTED_PACK_MAX_BYTES, materializeImportedPack, parseImportedPack } from "./imported-packs";

function fixture() {
  return {
    format: "glint-creation-pack", version: 1, id: "community-recipe", packVersion: "2.3.4",
    title: "Community recipe", description: "A portable static scene recipe", author: "Independent author",
    license: "MIT (author declared)", tags: ["editable", "中文"], permissions: [],
    project: {
      schemaVersion: 1, id: "recipe-project", title: "Editable project", aspect: "16:9", theme: "mint-clean",
      language: "en", fps: 30, knowledgeSources: [], scenes: [
        {
          id: "opening", kind: "title", title: "Plain <script>text</script> https://example.com", narration: { text: "Hello", durationMs: 3000 },
          notes: "Private working notes", elements: [{ id: "rule", kind: "rect", x: 0.1, y: 0.8, w: 0.8, h: 0.01, fill: "#112233" }],
          tracks: [{ elementId: "rule", property: "scale", keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1, easing: "ease-out" }] }],
          effects: [{ id: "dim", kind: "brightness", value: 1, keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 1 }] }],
          transition: { in: "fade", durationMs: 300 }, camera: { type: "push", intensity: 0.3 },
        },
        { id: "closing", kind: "bullets", items: ["First", "Second"], narration: { text: "Finish", durationMs: 3000 } },
      ],
    },
  };
}

function changed(path: string, value: unknown): ReturnType<typeof fixture> {
  const pack = fixture();
  let target = pack as unknown as Record<string, unknown>;
  const keys = path.split(".");
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return pack;
}

afterEach(() => vi.unstubAllGlobals());

describe("portable imported creation pack", () => {
  it("roundtrips detached metadata and an editable native project without private notes", () => {
    const source = fixture(), before = structuredClone(source), builtins = listCreationPacks();
    const parsed = parseImportedPack(source);
    expect(source).toEqual(before);
    expect(parsed).toMatchObject({ format: "glint-creation-pack", version: 1, packVersion: "2.3.4", author: source.author, license: source.license, permissions: [] });
    expect(parsed.project.scenes[0]).not.toHaveProperty("notes");
    expect(parsed.project.scenes[0]).toMatchObject({ title: source.project.scenes[0]!.title, tracks: source.project.scenes[0]!.tracks, effects: source.project.scenes[0]!.effects });
    expect(parseImportedPack(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    const instance = materializeImportedPack(parsed, { projectId: "chosen-project" });
    expect(instance.pack).toEqual({ id: source.id, version: "2.3.4" });
    expect(instance.inputs).toEqual({});
    expect(instance.project.creationPack).toEqual(instance.pack);
    expect(instance.project.id).toBe("chosen-project");
    expect(parseProject(JSON.parse(JSON.stringify(instance.project)))).toEqual(instance.project);
    expect(parseEditorProject(instance.project)).toEqual(instance.project);
    const edited = moveScene(changeNarration(instance.project, 0, "Edited locally"), 0, 1);
    expect(edited.scenes[1]!.narration.text).toBe("Edited locally");
    expect(edited.scenes[1]!.tracks).toEqual(source.project.scenes[0]!.tracks);
    expect(edited.scenes[1]!.effects).toEqual(source.project.scenes[0]!.effects);
    parsed.tags.push("local");
    parsed.project.scenes[0]!.narration.text = "changed recipe";
    instance.pack.version = "9.0.0";
    expect(instance.project.creationPack!.version).toBe("2.3.4");
    expect(instance.project.scenes[0]!.narration.text).toBe("Hello");
    expect(source).toEqual(before);
    expect(listCreationPacks()).toEqual(builtins);
  });

  it("defaults permissions, uses secure unique IDs, and is deterministic with an explicit ID", () => {
    const source = fixture() as Partial<ReturnType<typeof fixture>>;
    delete source.permissions;
    const parsed = parseImportedPack(source);
    expect(parsed.permissions).toEqual([]);
    expect(materializeImportedPack(parsed, { projectId: "fixed" })).toEqual(materializeImportedPack(parsed, { projectId: "fixed" }));
    const a = materializeImportedPack(parsed), b = materializeImportedPack(parsed);
    expect(a.project.id).toMatch(/^pack-[a-f0-9-]{36}$/);
    expect(a.project.id).not.toBe(b.project.id);
    vi.stubGlobal("crypto", undefined);
    expect(() => materializeImportedPack(parsed)).toThrow("crypto.randomUUID");
    expect(materializeImportedPack(parsed, { projectId: "offline" }).project.id).toBe("offline");
  });

  it.each([
    { kind: "definition", term: "Term", definition: "Meaning" },
    { kind: "quote", text: "Original statement", attribution: "Author" },
    { kind: "comparison", left: { label: "A", points: ["One"] }, right: { label: "B", points: ["Two"] } },
    { kind: "chart", chartType: "bar", data: [{ label: "A", value: 4 }] },
    { kind: "diagram", steps: [{ label: "Begin" }, { label: "End" }] },
    { kind: "code", code: "fetch('https://example.com'); eval('inert display text')", language: "javascript" },
  ])("supports native $kind as data without invoking code or network", scene => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const source = changed("project.scenes", [{ ...scene, id: "portable", narration: { text: "Explain", durationMs: 1000 } }]);
    const project = materializeImportedPack(parseImportedPack(source), { projectId: "portable" }).project;
    expect(project.scenes[0]).toMatchObject(scene);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("import trust boundary", () => {
  it.each([
    ["format", "plugin"], ["version", 2], ["version", "1"], ["id", "../escape"], ["id", "a".repeat(121)],
    ["packVersion", "1.2"], ["packVersion", "01.2.3"], ["packVersion", "1.2.3-beta"], ["packVersion", "1.2.3+build"],
    ["title", " "], ["description", "x".repeat(1001)], ["author", ""], ["license", null], ["tags", "tag"],
    ["tags", ["duplicate", "duplicate"]], ["tags", Array(21).fill("tag")], ["tags", [42]],
    ["permissions", ["network"]], ["permissions", {}], ["capabilities", []], ["execute", "code"], ["inputs", {}],
    ["project.schemaVersion", 2], ["project.knowledgeSources", [{ id: "external", kind: "markdown", name: "https://example.com" }]],
    ["project.assets", []], ["project.music", { src: "https://example.com/music.mp3" }], ["project.sfx", []],
    ["project.theme", { fontFamily: "url(https://example.com/font)" }], ["project.theme", "https://example.com"],
    ["project.plugin", "script"], ["project.scenes.0.kind", "html"], ["project.scenes.0.kind", "three"],
    ["project.scenes.0.kind", "image"], ["project.scenes.0.kind", "video"], ["project.scenes.0.kind", "unknown"],
    ["project.scenes.0.src", "assets/image.png"], ["project.scenes.0.html", "<script>evil()</script>"],
    ["project.scenes.0.assetRefs", []], ["project.scenes.0.narration.audioRef", "assets/audio.mp3"],
    ["project.scenes.0.narration.url", "https://example.com"], ["project.scenes.0.narration.text", " "],
    ["project.scenes.0.code", "execute as extra field"], ["project.scenes.0.elements.0.src", "https://example.com"],
    ["project.scenes.0.tracks.0.elementId", "missing"], ["project.scenes.1.id", "opening"],
    ["project.scenes.0.tracks.0.keyframes.1.atMs", 0], ["project.scenes.0.effects.0.value", Infinity],
    ["project.scenes.0.title", "x".repeat(4097)], ["project.scenes.0.id", "x".repeat(121)],
  ])("rejects invalid or undeclared %s", (path, value) => {
    expect(() => parseImportedPack(changed(path as string, value))).toThrow();
  });

  it("rejects malformed projects, duplicate elements/effects, excessive scenes and multibyte JSON size", () => {
    for (const bad of [null, [], {}, "{}", undefined, 42]) expect(() => parseImportedPack(bad)).toThrow();
    const noScenes = fixture(); noScenes.project.scenes = [];
    expect(() => parseImportedPack(noScenes)).toThrow("1–20");
    const many = fixture();
    many.project.scenes = Array.from({ length: 21 }, (_, i) => ({ ...many.project.scenes[0]!, id: `scene-${i}` }));
    expect(() => parseImportedPack(many)).toThrow("1–20");
    many.project.scenes.pop();
    expect(parseImportedPack(many).project.scenes).toHaveLength(20);
    for (const key of ["elements", "effects"] as const) {
      const duplicate = fixture(), array = duplicate.project.scenes[0]![key]!;
      array.push(structuredClone(array[0]!) as never);
      expect(() => parseImportedPack(duplicate)).toThrow("duplicate");
    }
    const huge = changed("project.scenes", Array.from({ length: 20 }, (_, i) => ({ ...fixture().project.scenes[0]!, id: `scene-${i}`, title: "界".repeat(4096) })));
    expect(new TextEncoder().encode(JSON.stringify(huge)).byteLength).toBeGreaterThan(IMPORTED_PACK_MAX_BYTES);
    expect(() => parseImportedPack(huge)).toThrow("128 KiB");
  });

  it("rejects prototypes, reserved keys, hidden properties and accessors before reading them", () => {
    const getter = vi.fn(() => "executed");
    const candidates: unknown[] = [new Date(), Object.create({ inherited: true }), { ...fixture(), [Symbol("hidden")]: true }];
    for (const reserved of ["__proto__", "constructor", "prototype", "toJSON"]) {
      const pack = fixture();
      Object.defineProperty(pack.project.scenes[0], reserved, { enumerable: true, value: "reserved" });
      candidates.push(pack);
    }
    for (const enumerable of [true, false]) {
      const pack = fixture(); Object.defineProperty(pack.project.scenes[0], "title", { enumerable, get: getter });
      candidates.push(pack);
    }
    const hidden = fixture(); Object.defineProperty(hidden, "secret", { value: "hidden" }); candidates.push(hidden);
    const cycle = fixture() as unknown as Record<string, unknown>; cycle.loop = cycle; candidates.push(cycle);
    const sparse = fixture(); sparse.tags = Array(1); candidates.push(sparse);
    const extraArray = fixture(); Object.defineProperty(extraArray.tags, "extra", { value: "extra" }); candidates.push(extraArray);
    for (const value of candidates) expect(() => parseImportedPack(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(Object.prototype).not.toHaveProperty("polluted");
    const nullPrototype = Object.assign(Object.create(null), fixture());
    expect(parseImportedPack(nullPrototype).id).toBe("community-recipe");
  });

  it("rejects non-JSON primitives and resource exhaustion before clone", () => {
    for (const value of [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity]) {
      expect(() => parseImportedPack(changed("project.scenes.0.title", value))).toThrow();
    }
    let deep: unknown = "leaf";
    for (let i = 0; i < 45; i++) deep = { nested: deep };
    expect(() => parseImportedPack(changed("project.theme", deep))).toThrow("deeply nested");
    expect(() => parseImportedPack(changed("tags", Array(20_001).fill("x")))).toThrow("too large");
  });

  it("revalidates modified installs and validates materialization options without getter execution", () => {
    const pack = parseImportedPack(fixture());
    (pack.permissions as string[]).push("network");
    expect(() => materializeImportedPack(pack, { projectId: "safe" })).toThrow("permissions");
    const valid = parseImportedPack(fixture());
    for (const projectId of ["", "../project", "UPPER", "a".repeat(121), null]) {
      expect(() => materializeImportedPack(valid, { projectId } as { projectId: string })).toThrow("projectId");
    }
    const getter = vi.fn(() => "safe");
    const accessor = Object.defineProperty({}, "projectId", { enumerable: true, get: getter });
    expect(() => materializeImportedPack(valid, accessor)).toThrow("accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(() => materializeImportedPack(valid, { plugin: "execute" } as unknown as { projectId: string })).toThrow("unsupported");
  });
});
