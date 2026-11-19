import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePortableChapterBundle } from "./portable-chapter-validation";
import { parseProject } from "./parse";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const asset = (bytes = png) => ({ path: "assets/hero.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, data: bytes.toString("base64") });
const chapter = (id: string) => ({
  snapshot: { title: "章节名称", updatedAt: 123, context: { mode: "source", text: "创作资料", template: "explainer", theme: "whiteboard", evidence: "依据" },
    project: parseProject({ schemaVersion: 1, id, title: "工程标题", aspect: "16:9", knowledgeSources: [],
      assets: [{ id: "hero", kind: "character", name: "角色", version: "v1", refs: ["assets/hero.png"] }],
      scenes: [{ id: "one", kind: "image", src: "assets/hero.png", narration: { text: "正文", durationMs: 1000 } }] }) },
  assets: [asset()],
});
const bundle = () => ({ format: "glint-chapters-portable", version: 2, chapters: [chapter("one"), chapter("two")] });

describe("portable chapter bundle validation", () => {
  it("retains complete ordered snapshots and deduplicates verified content", () => {
    const result = validatePortableChapterBundle(JSON.stringify(bundle()));
    expect(result.chapters.map(item => item.snapshot.project.id)).toEqual(["one", "two"]);
    expect(result.chapters[0]!.snapshot).toMatchObject({ title: "章节名称", updatedAt: 123, context: { text: "创作资料", evidence: "依据" } });
    expect(result.blobs.size).toBe(1);
    expect([...result.blobs.values()][0]!.bytes).toEqual(png);
  });

  it("rejects old incomplete metadata and malformed base64", () => {
    expect(() => validatePortableChapterBundle(JSON.stringify({ ...bundle(), version: 1 }))).toThrow(/版本 2/);
    const missing = bundle(); (missing.chapters[0]!.snapshot as { context?: unknown }).context = undefined;
    expect(() => validatePortableChapterBundle(JSON.stringify(missing))).toThrow(/上下文|快照/);
    const invalid = bundle(); invalid.chapters[0]!.assets[0]!.data += "!";
    expect(() => validatePortableChapterBundle(JSON.stringify(invalid))).toThrow(/无效/);
  });

  it("rejects a corrupted final asset before returning any install plan", () => {
    const invalid = bundle(); invalid.chapters[1]!.assets[0]!.data = Buffer.from("changed").toString("base64");
    expect(() => validatePortableChapterBundle(JSON.stringify(invalid))).toThrow(/校验/);
  });

  it("rejects mismatched media signatures even when the hash is correct", () => {
    const invalid = bundle(); invalid.chapters[0]!.assets[0] = asset(Buffer.from("not an image"));
    expect(() => validatePortableChapterBundle(JSON.stringify(invalid))).toThrow(/校验/);
  });

  it("rejects background music outside the embedded asset manifest", () => {
    const outside = bundle();
    (outside.chapters[0]!.snapshot.project as { music?: { src: string } }).music = { src: "music/theme.mp3" };
    expect(() => validatePortableChapterBundle(JSON.stringify(outside))).toThrow(/背景音乐/);
  });

  it("rejects unembedded scene and identity media as well as unknown snapshot data", () => {
    const outside = bundle();
    (outside.chapters[0]!.snapshot.project.scenes[0] as { src: string }).src = "images/hero.png";
    outside.chapters[0]!.snapshot.project.assets = [];
    outside.chapters[0]!.assets = [];
    expect(() => validatePortableChapterBundle(JSON.stringify(outside))).toThrow(/local assets/);
    const identity = bundle();
    for (const item of identity.chapters) item.snapshot.project.assets![0]!.refs = ["images/hero.png"];
    expect(() => validatePortableChapterBundle(JSON.stringify(identity))).toThrow();
    const unknown = bundle();
    (unknown.chapters[0]!.snapshot.context as Record<string, unknown>).extra = "保留我";
    expect(() => validatePortableChapterBundle(JSON.stringify(unknown))).toThrow(/无法完整恢复/);
  });

  it("refuses HTML scenes with dependencies outside the asset manifest", () => {
    const input = bundle();
    input.chapters[0]!.snapshot.project = parseProject({ schemaVersion: 1, id: "one", title: "one", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "scene", kind: "html", html: '<img src="images/missing.png">', narration: { text: "test", durationMs: 1000 } },
    ] });
    input.chapters[0]!.assets = [];
    expect(() => validatePortableChapterBundle(JSON.stringify(input))).toThrow(/HTML 场景/);
  });

  it("rejects duplicate chapter IDs, missing references and conflicting asset identity", () => {
    const duplicate = bundle(); duplicate.chapters[1]!.snapshot.project.id = "one";
    expect(() => validatePortableChapterBundle(JSON.stringify(duplicate))).toThrow(/重复/);
    const missing = bundle(); missing.chapters[0]!.assets = [];
    expect(() => validatePortableChapterBundle(JSON.stringify(missing))).toThrow(/清单/);
    const conflict = bundle(); conflict.chapters[1]!.snapshot.project.assets![0]!.name = "另一角色";
    expect(() => validatePortableChapterBundle(JSON.stringify(conflict))).toThrow(/不一致/);
    const differentBytes = bundle(); differentBytes.chapters[1]!.assets[0] = asset(Buffer.concat([png, Buffer.from([0])]));
    expect(() => validatePortableChapterBundle(JSON.stringify(differentBytes))).toThrow(/不一致/);
  });
});
