import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "@glintai/scenescript";
import { applySemanticEdit, compareProjects } from "./edits";
import { projectSha256 } from "./build";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-edits-test-"));
  roots.push(root);
  const file = path.join(root, "project.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, id: "edits-fixture", title: "Edits", aspect: "16:9", fps: 30, knowledgeSources: [], theme: "hand-note",
    scenes: [
      { id: "intro", kind: "title", title: "旧标题", subtitle: "副标题", narration: { text: "旧旁白", durationMs: 1200, segments: [{ text: "旧旁白", startMs: 0, endMs: 1200 }], audioRef: "old.mp3" } },
      { id: "chart", kind: "chart", chartType: "bar", data: [{ label: "甲", value: 3 }, { label: "乙", value: 5 }], narration: { text: "图表", durationMs: 900 } },
    ],
  }, null, 2));
  return file;
}
const read = (file: string) => parseProject(JSON.parse(fs.readFileSync(file, "utf8")));
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("semantic edits", () => {
  it("sets a real string field and rejects a field the scene does not have", () => {
    const file = fixture();
    applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "intro", field: "title", value: "新标题" });
    expect((read(file).scenes[0] as { title?: string }).title).toBe("新标题");
    expect(() => applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "intro", field: "chartType", value: "line" })).toThrow(/no string field/);
    expect(() => applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "ghost", field: "title", value: "x" })).toThrow(/Unknown scene/);
  });
  it("rewrites narration and drops stale timings/audio", () => {
    const file = fixture();
    applySemanticEdit({ projectPath: file, op: "set_narration", sceneId: "intro", value: "全新的旁白" });
    const narration = read(file).scenes[0]!.narration;
    expect(narration.text).toBe("全新的旁白");
    expect(narration.durationMs).toBeUndefined();
    expect(narration.segments).toBeUndefined();
    expect(narration.audioRef).toBeUndefined();
  });
  it("sets timing and invalidates word timings", () => {
    const file = fixture();
    applySemanticEdit({ projectPath: file, op: "set_timing", sceneId: "intro", value: 2500 });
    const narration = read(file).scenes[0]!.narration;
    expect(narration.durationMs).toBe(2500);
    expect(narration.segments).toBeUndefined();
    expect(() => applySemanticEdit({ projectPath: file, op: "set_timing", sceneId: "intro", value: 10 })).toThrow(/100\.\.600000/);
  });
  it("edits chart points and rejects wrong kinds or indexes", () => {
    const file = fixture();
    applySemanticEdit({ projectPath: file, op: "set_chart_value", sceneId: "chart", index: 1, value: 9 });
    const scene = read(file).scenes[1]!;
    expect(scene.kind === "chart" && scene.data[1]!.value).toBe(9);
    expect(() => applySemanticEdit({ projectPath: file, op: "set_chart_value", sceneId: "chart", index: 9, value: 1 })).toThrow(/0\.\.1/);
    expect(() => applySemanticEdit({ projectPath: file, op: "set_chart_value", sceneId: "intro", index: 0, value: 1 })).toThrow(/chart scenes/);
  });
  it("changes theme and moves scenes", () => {
    const file = fixture();
    applySemanticEdit({ projectPath: file, op: "set_theme", value: "editorial" });
    expect(read(file).theme).toBe("editorial");
    applySemanticEdit({ projectPath: file, op: "move_scene", sceneId: "chart", to: 0 });
    expect(read(file).scenes.map(scene => scene.id)).toEqual(["chart", "intro"]);
  });
  it("refuses a stale expected revision and leaves the file untouched", () => {
    const file = fixture(), original = fs.readFileSync(file, "utf8");
    expect(() => applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "intro", field: "title", value: "x", expectedRevision: "sha256:stale" })).toThrow(/Revision conflict/);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });
  it("only writes when the parsed project is still valid", () => {
    const file = fixture();
    const before = projectSha256(read(file));
    applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "intro", field: "subtitle", value: "新副标题" });
    expect(projectSha256(read(file))).not.toBe(before);
  });
});

describe("semantic project diff", () => {
  it("reports field-level changes, moves, additions and removals by scene id", () => {
    const file = fixture();
    const before = read(file);
    applySemanticEdit({ projectPath: file, op: "set_text", sceneId: "intro", field: "title", value: "新标题" });
    applySemanticEdit({ projectPath: file, op: "move_scene", sceneId: "chart", to: 0 });
    const after = read(file);
    const diff = compareProjects(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.moved).toEqual([{ id: "intro", from: 0, to: 1 }, { id: "chart", from: 1, to: 0 }]);
    expect(diff.changed.find(scene => scene.id === "intro")?.fields).toContain("title");
  });
  it("labels an unchanged project as identical", () => {
    const file = fixture();
    expect(compareProjects(read(file), read(file)).identical).toBe(true);
  });
});
