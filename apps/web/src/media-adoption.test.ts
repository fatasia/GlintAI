import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { adoptLibraryVisual, libraryVisual } from "./media-adoption";
const project = () => parseProject({ schemaVersion: 1, id: "adopt", title: "Adopt", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "video", src: "assets/old.mp4", speed: 2, trimStartSec: 1, trimEndSec: 4, caption: "Caption", provenance: { origin: "generated", model: "old" },
    narration: { text: "Keep voice", durationMs: 1000 }, elements: [{ id: "text", kind: "text", text: "Keep text" }], effects: [{ id: "mono", kind: "grayscale", value: 1 }] },
  { id: "two", kind: "title", title: "Keep title", narration: { text: "Keep narration", durationMs: 1000 } },
] });
describe("explicit visual adoption", () => {
  it("replaces just source while retaining authored overlays, effects, narration and scene identity", () => {
    const before = project(), snapshot = JSON.stringify(before);
    const next = adoptLibraryVisual(before, "one", "new.png", "replace");
    expect(next.scenes[0]).toMatchObject({ id: "one", kind: "image", src: "assets/new.png", caption: "Caption", narration: before.scenes[0]!.narration, elements: before.scenes[0]!.elements, effects: before.scenes[0]!.effects });
    expect(next.scenes[0]).not.toHaveProperty("speed"); expect(next.scenes[0]).not.toHaveProperty("trimStartSec"); expect(next.scenes[0]).not.toHaveProperty("provenance");
    expect(next.scenes[1]).toEqual(before.scenes[1]); expect(JSON.stringify(before)).toBe(snapshot);
  });
  it("inserts a new video without flattening structured content and rejects destructive replacement", () => {
    const before = project();
    expect(() => adoptLibraryVisual(before, "two", "new.mp4", "replace")).toThrow(/结构化/);
    const next = adoptLibraryVisual(before, "two", "new.mp4", "insert", "new-shot");
    expect(next.scenes).toHaveLength(3); expect(next.scenes[1]).toEqual(before.scenes[1]);
    expect(next.scenes[2]).toMatchObject({ id: "new-shot", kind: "video", src: "assets/new.mp4", narration: { durationMs: 3000 } });
  });
  it("respects target and downstream locks and safe file identity", () => {
    const before = project(); before.scenes[1]!.locked = true;
    expect(() => adoptLibraryVisual(before, "two", "new.mp4", "replace")).toThrow(/锁定/);
    expect(() => adoptLibraryVisual(before, "one", "new.mp4", "insert", "new-shot")).toThrow(/锁定/);
    for (const name of ["../x.png", "https://evil/a.mp4", "voice.mp3", "x.PNG", "foo/bar.png", "x.png?x=1"]) expect(() => libraryVisual(name)).toThrow();
    expect(() => adoptLibraryVisual(before, "missing", "new.png", "insert")).toThrow(/不存在/);
  });
});
