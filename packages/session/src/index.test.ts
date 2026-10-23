import { describe, expect, it } from "vitest";
import { ProjectSession, pathFromDot, type EditTransaction } from "./index";
const tx = (baseRevision: number, operations: EditTransaction["operations"], id = `tx-${baseRevision + 1}`): EditTransaction => ({ id, projectId: "demo", baseRevision, actor: "skill", scope: {}, operations, intent: "局部修改" });
const document = () => ({ id: "demo", title: "旧标题", scenes: [{ id: "a", narration: { text: "A" } }, { id: "b", narration: { text: "B" } }] });
describe("ProjectSession domain", () => {
  it("applies in memory without claiming persistence or independent verification", () => {
    const session = new ProjectSession("demo", document());
    expect(session.submit(tx(0, [{ kind: "set", path: ["title"], value: "18%" }])).stage).toBe("dispatched");
    expect(session.verify("tx-1").stage).toBe("dispatched");
    expect(session.snapshot().document.title).toBe("18%");
  });
  it("rejects stale versions, failed preconditions and different transaction id reuse", () => {
    const session = new ProjectSession("demo", document());
    const edit = tx(0, [{ kind: "set", path: ["title"], value: "18%" }]);
    session.submit(edit); expect(session.submit(edit).revision).toBe(1);
    expect(session.submit(tx(0, edit.operations, "other")).reason).toContain("Revision conflict");
    expect(session.submit({ ...edit, operations: [] }).reason).toContain("reused");
    expect(session.submit({ ...tx(1, edit.operations), preconditions: [{ kind: "equals", path: ["title"], value: "wrong" }] }).reason).toContain("Precondition");
    expect(session.look().revision).toBe(1);
  });
  it("rolls back a multi-operation transaction atomically", () => {
    const session = new ProjectSession("demo", document());
    expect(session.submit(tx(0, [{ kind: "set", path: ["title"], value: "changed" }, { kind: "move", path: ["scenes"], from: 5, to: 0 }])).stage).toBe("refused");
    expect(session.snapshot().document).toEqual(document());
  });
  it("rejects raw prototype paths, malformed operations, JSON values and identity edits", () => {
    const session = new ProjectSession("demo", document());
    const bad = [
      { kind: "set", path: ["__proto__", "polluted"], value: true },
      { kind: "set", path: ["scenes", "01"], value: {} },
      { kind: "set", path: ["title"], value: undefined },
      { kind: "set", path: ["title"], value: NaN },
      { kind: "set", path: ["id"], value: "other" },
      { kind: "unknown", path: ["title"] },
    ];
    for (const op of bad) expect(session.submit(tx(0, [op] as EditTransaction["operations"])).stage).toBe("refused");
    expect(session.submit(null as unknown as EditTransaction).stage).toBe("refused");
    expect(session.look().revision).toBe(0); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => pathFromDot("constructor.x")).toThrow();
  });
  it("enforces scene scope even for raw API operations", () => {
    const session = new ProjectSession("demo", document());
    const scoped = { ...tx(0, [{ kind: "set" as const, path: ["scenes", "0", "narration", "text"], value: "New" }]), scope: { handles: ["a"] } };
    expect(session.submit(scoped).stage).toBe("dispatched");
    expect(session.submit({ ...tx(1, [{ kind: "set", path: ["scenes", "1", "narration", "text"], value: "Wrong" }]), scope: scoped.scope }).stage).toBe("refused");
    expect(session.snapshot().document.scenes[1]!.narration.text).toBe("B");
  });
  it("reverses array delete/insert/move in one shared undo stack across restart", () => {
    const session = new ProjectSession("demo", document());
    session.submit(tx(0, [{ kind: "delete", path: ["scenes", "0"] }, { kind: "insert", path: ["scenes"], index: 1, value: { id: "c", narration: { text: "C" } } }, { kind: "move", path: ["scenes"], from: 1, to: 0 }]));
    expect(session.snapshot().document.scenes.map(s => s.id)).toEqual(["c", "b"]);
    const state = session.exportState(); const restored = new ProjectSession(state.projectId, state.document, state.revision, state.history);
    expect(restored.historyEdit("undo", "undo-1", 1, "user").stage).toBe("dispatched");
    expect(restored.snapshot().document).toEqual(document()); expect(restored.look().redoDepth).toBe(1);
    restored.historyEdit("redo", "redo-1", 2, "cli");
    expect(restored.snapshot().document.scenes.map(s => s.id)).toEqual(["c", "b"]);
    expect(restored.historyEdit("redo", "redo-1", 2, "cli").revision).toBe(3);
  });
  it("records no-op receipts without adding undo actions", () => {
    const session = new ProjectSession("demo", document());
    expect(session.submit(tx(0, [])).changed).toBe(false);
    expect(session.look().undoDepth).toBe(0); expect(session.verify("tx-1").revision).toBe(1);
  });
  it("runs document validation before commit and validates selection", () => {
    const session = new ProjectSession("demo", document(), 0, [], [], doc => { if (!doc.title.trim()) throw new Error("Empty title"); });
    expect(session.submit(tx(0, [{ kind: "set", path: ["title"], value: "" }])).stage).toBe("refused");
    expect(() => session.select(["missing"])).toThrow(); session.select(["b"]);
    expect(session.look().selection).toEqual(["b"]);
  });
});
