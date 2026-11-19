import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { boardContentIdentity, changeBoardContent, type BoardContent } from "./project-board-content";
const state = (): BoardContent => ({
  project: parseProject({ schemaVersion: 1, id: "board", title: "Board", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "First", narration: { text: "One" } }, { id: "two", kind: "title", title: "Second", narration: { text: "Two" } },
  ] }),
  scripts: { version: 1, projectId: "board", activeId: "s", documents: [{ id: "s", title: "Script", kind: "script", content: "Exact source", updatedAt: 1 }] },
  workspace: { version: 1, projectId: "board", brand: null, assets: [], designs: { version: 1, projectId: "board", activeId: "d", documents: [{ id: "d", title: "Slides", kind: "slides", updatedAt: 1, activePageId: "p", pages: [{ id: "p", title: "Page", html: "<h1 data-design-id='title'>Hello</h1>", notes: "Speaker" }] }] } },
});
it("duplicates mixed content in one immutable snapshot with new identities and source intact", () => {
  const before = state(), raw = JSON.stringify(before); let id = 0;
  const next = changeBoardContent(before, { kind: "duplicate", keys: ["scene:one", "script:s", "design:d:p"] }, () => `new-${++id}`);
  expect(JSON.stringify(before)).toBe(raw);
  expect(next.project.scenes.map(scene => scene.id)).toEqual(["one", "copy-new-1", "two"]);
  expect(next.scripts.documents[1]).toMatchObject({ id: "new-2", content: "Exact source" });
  expect(next.workspace.designs.documents[0]!.pages[1]).toMatchObject({ id: "new-3", notes: "Speaker", html: before.workspace.designs.documents[0]!.pages[0]!.html });
  expect(Object.keys(next.workspace.board!.positions)).toHaveLength(3);
});
it("deletes references and updates active documents without touching the original", () => {
  const before = state();
  const next = changeBoardContent(before, { kind: "delete", keys: ["scene:one", "script:s", "design:d:p"] });
  expect(next.project.scenes.map(scene => scene.id)).toEqual(["two"]);
  expect(next.scripts).toMatchObject({ documents: [], activeId: "" });
  expect(next.workspace.designs).toMatchObject({ documents: [], activeId: "" });
  expect(before.workspace.designs.documents).toHaveLength(1);
});
it("rejects asset-file deletion, missing selections, frozen projects and the last scene", () => {
  const before = state();
  for (const keys of [[], ["asset:owned.png"], ["scene:missing"], ["scene:one", "scene:two"]]) expect(() => changeBoardContent(before, { kind: "delete", keys })).toThrow();
  before.project.frozen = true;
  expect(() => changeBoardContent(before, { kind: "duplicate", keys: ["script:s"] })).toThrow(/冻结/);
});
it("preserves locked scene timing on both deletion and duplication", () => {
  const before = state(); before.project.scenes[1]!.locked = true;
  for (const kind of ["delete", "duplicate"] as const) expect(() => changeBoardContent(before, { kind, keys: ["scene:one"] })).toThrow(/开始时间/);
});
it("renames one page and keeps the document identity, source and notes", () => {
  const before = state(), next = changeBoardContent(before, { kind: "rename", keys: ["design:d:p"], title: "  Overview  " });
  expect(next.workspace.designs.documents[0]!.pages[0]).toEqual({ ...before.workspace.designs.documents[0]!.pages[0], title: "Overview" });
  expect(boardContentIdentity(next)).not.toBe(boardContentIdentity(before));
  const moved = structuredClone(before); moved.workspace.board = { positions: {}, viewport: { x: 20, y: 30, zoom: .5 } };
  expect(boardContentIdentity(moved)).toBe(boardContentIdentity(before));
});
it("groups mixed references, duplicates an entire group and removes obsolete memberships",()=>{
 const before=state();let count=0;
 const grouped=changeBoardContent(before,{kind:"group",keys:["script:s","design:d:p"]},()=>`id-${++count}`);
 expect(grouped.workspace.board!.groups![0]!.members).toEqual(["script:s","design:d:p"]);
 const copied=changeBoardContent(grouped,{kind:"duplicate",keys:["script:s","design:d:p"]},()=>`id-${++count}`);
 expect(copied.workspace.board!.groups).toHaveLength(2);
 expect(copied.workspace.board!.groups![1]!.members).toEqual(["script:id-2","design:d:id-3"]);
 const deleted=changeBoardContent(grouped,{kind:"delete",keys:["script:s"]});expect(deleted.workspace.board!.groups).toEqual([]);
 const ungrouped=changeBoardContent(grouped,{kind:"ungroup",keys:["script:s"]});expect(ungrouped.workspace.board!.groups).toEqual([]);
 expect(before.workspace.board).toBeUndefined();
});
