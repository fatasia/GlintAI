import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";
import { applyTranslations, parseTranslationPack, translationCoverage, type TranslationPack } from "./translations";

const project = parseProject({
  schemaVersion: 1, id: "tr", title: "咖啡", aspect: "16:9", knowledgeSources: [],
  scenes: [
    { id: "one", kind: "title", title: "开场", narration: { text: "第一句", durationMs: 1500 } },
    { id: "two", kind: "bullets", heading: "要点", items: ["甲", "乙"], narration: { text: "第二句", durationMs: 2000 } },
  ],
});

const pack: TranslationPack = parseTranslationPack({
  version: 1,
  tracks: [
    { language: "en", scenes: {
      "one": { title: "Opening", text: "First line." },
      "two": { heading: "Points", items: ["A", "B"], text: "Second line." },
    } },
    { language: "ja", scenes: { "one": { title: "オープニング", text: "一行目。" } } },
  ],
});

describe("translation layer", () => {
  it("swaps declared text fields and leaves ids, timing and assets identical", () => {
    const { project: en } = applyTranslations(project, pack, "en");
    expect(en.scenes.map(scene => scene.id)).toEqual(["one", "two"]);
    expect((en.scenes[0] as { title: string }).title).toBe("Opening");
    expect(en.scenes[0]!.narration).toMatchObject({ text: "First line.", durationMs: 1500 });
    expect((en.scenes[1] as { items: string[] }).items).toEqual(["A", "B"]);
    // Master project stays untouched.
    expect((project.scenes[0] as { title: string }).title).toBe("开场");
  });

  it("reports untranslated scenes and keeps master copy for them", () => {
    const { project: ja, untranslated } = applyTranslations(project, pack, "ja");
    expect(untranslated).toEqual(["two"]);
    expect((ja.scenes[1] as { heading: string }).heading).toBe("要点");
    expect(ja.scenes[1]!.narration.text).toBe("第二句");
  });

  it("returns the master project when the language is absent", () => {
    const { project: same, untranslated } = applyTranslations(project, pack, "de");
    expect(same).toBe(project);
    expect(untranslated).toEqual(["one", "two"]);
  });

  it("degrades a broken pack to empty and reports full coverage gaps", () => {
    expect(parseTranslationPack("nope").tracks).toEqual([]);
    expect(translationCoverage(project, pack)).toEqual([
      { language: "en", missing: [] },
      { language: "ja", missing: ["two"] },
    ]);
  });
});
