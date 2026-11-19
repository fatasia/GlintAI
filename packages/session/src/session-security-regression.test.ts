import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectSession, canonicalJson, type EditTransaction } from "./index";
import { createHash } from "node:crypto";
import { FileSessionStore } from "./node";

const edit = (id: string, revision: number, operations: EditTransaction["operations"]): EditTransaction => ({ id, projectId: "audit", baseRevision: revision, actor: "user", scope: {}, intent: id, operations });
const set = (path: string[], value: unknown): EditTransaction["operations"][number] => ({ kind: "set", path, value });

it("refuses stale undo and redo after overlapping amendments while preserving unrelated history", () => {
  const session = new ProjectSession("audit", { items: [{ id: "a", n: 0 }, { id: "b", n: 9 }], title: "a" });
  expect(session.submit(edit("edit", 0, [set(["items", "0", "n"], 1)])).stage).toBe("dispatched");
  session.amend({ ...session.snapshot().document, title: "b" });
  expect(session.historyEdit("undo", "undo", 2, "user").stage).toBe("dispatched");
  expect(session.snapshot().document.title).toBe("b");
  session.amend({ items: [{ id: "b", n: 9 }, { id: "a", n: 0 }], title: "b" });
  const before = session.snapshot();
  expect(session.historyEdit("redo", "redo", 4, "user").stage).toBe("refused");
  expect(session.snapshot()).toEqual(before);
});

it("does not replay history against a replaced array or an amended value", () => {
  const session = new ProjectSession("audit", { items: [{ id: "a", n: 0 }, { id: "b", n: 9 }] });
  session.submit(edit("edit", 0, [set(["items", "0", "n"], 1)]));
  session.amend({ items: [{ id: "b", n: 9 }, { id: "a", n: 1 }] });
  expect(session.historyEdit("undo", "undo", 2, "user").stage).toBe("refused");
  expect(session.snapshot().document.items[0]).toEqual({ id: "b", n: 9 });
  const second = new ProjectSession("audit", { n: 0 });
  second.submit(edit("edit", 0, [set(["n"], 1)])); second.historyEdit("undo", "undo", 1, "user");
  second.amend({ n: 77 }); expect(second.historyEdit("redo", "redo", 3, "user").stage).toBe("refused");
  expect(second.snapshot().document.n).toBe(77);
});

it("preserves redo across compaction, later undo records and export/restore", () => {
  const session = new ProjectSession("audit", { n: 0, title: "" });
  for (let i = 0; i < 3; i++) session.submit(edit(`edit-${i}`, i, [set(["n"], i + 1)]));
  session.historyEdit("undo", "undo", 3, "user");
  for (let i = 0; i < 170; i++) { session.amend({ ...session.snapshot().document, title: String(i) }); session.compactHistory(160); }
  const saved = session.exportState(), restored = new ProjectSession(saved.projectId, saved.document, saved.revision, saved.history);
  expect(restored.look().redoDepth).toBe(1);
  expect(restored.historyEdit("redo", "redo", restored.look().revision, "user").stage).toBe("dispatched");
  expect(restored.snapshot().document.n).toBe(3);
  const second = new ProjectSession("audit", { n: 0 });
  for (let i = 0; i < 4; i++) second.submit(edit(`e${i}`, i, [set(["n"], i + 1)]));
  second.historyEdit("undo", "u1", 4, "user"); second.historyEdit("undo", "u2", 5, "user");
  second.compactHistory(2);
  expect(second.look().redoDepth).toBe(2);
  expect(second.historyEdit("redo", "r1", 6, "user").stage).toBe("dispatched");
  expect(second.historyEdit("redo", "r2", 7, "user").stage).toBe("dispatched");
  expect(second.snapshot().document.n).toBe(4);
});

it("keeps exact transaction receipts and idempotency through repeated compaction and restoration", () => {
  const session = new ProjectSession("audit", { n: 0 });
  const transactions = Array.from({ length: 8 }, (_, i) => edit(`t${i}`, i, [set(["n"], i + 1)]));
  const receipts = transactions.map(transaction => session.submit(transaction));
  session.compactHistory(2); session.compactHistory(1);
  const state = session.exportState();
  const restored = new ProjectSession(state.projectId, state.document, state.revision, state.history);
  for (let i = 0; i < transactions.length; i++) {
    expect(restored.submit(transactions[i]!)).toEqual(receipts[i]);
    expect(restored.verify(`t${i}`)).toMatchObject({ ...receipts[i], reason: "Persistence readback is required" });
    expect(restored.submit({ ...transactions[i]!, intent: "different" }).stage).toBe("refused");
  }
  expect(restored.snapshot().document.n).toBe(8);
});

it("keeps undo receipts and idempotent retries through compaction", () => {
  const session = new ProjectSession("audit", { n: 0 });
  session.submit(edit("edit", 0, [set(["n"], 1)]));
  const undone = session.historyEdit("undo", "undo", 1, "user");
  session.amend({ n: 0 }); session.compactHistory(1);
  const state = session.exportState(), restored = new ProjectSession(state.projectId, state.document, state.revision, state.history);
  expect(restored.historyEdit("undo", "undo", 1, "user")).toEqual(undone);
  expect(restored.historyEdit("undo", "undo", 1, "cli").stage).toBe("refused");
  expect(restored.look().redoDepth).toBe(1);
});

it("refuses array index shifts introduced by a later ordinary edit before redo", () => {
 const session = new ProjectSession("audit", { items: [{ id: "a", n: 0 }, { id: "b", n: 9 }] });
 session.submit(edit("e", 0, [set(["items", "0", "n"], 1)]));
 session.historyEdit("undo", "u", 1, "user");
 session.submit(edit("reorder", 2, [{kind: "move", path: ["items"], from: 0, to: 1}]));
 expect(session.look().redoDepth).toBe(0);
});

it("undoes and redoes removal of a legacy approved asset", () => {
 const asset = { id: "p", kind: "product", name: "Item", approval: { name: "Item" } };
 // Reconstruct a historical state that predates the current guard.
 const removed: EditTransaction = { id: "old-delete", projectId: "audit", baseRevision: 0, actor: "user", scope: {}, intent: "old", operations: [{ kind: "delete", path: ["assets", "0"] }] };
 const history = [{ revision: 1, transaction: removed, inverse: [{ kind: "insert" as const, path: ["assets"], index: 0, value: asset }], digest: "legacy", action: "edit" as const, changed: true }];
 const session = new ProjectSession("audit", { assets: [] as typeof asset[] }, 1, history);
 expect(session.historyEdit("undo", "undo", 1, "user").stage).toBe("dispatched");
 expect(session.snapshot().document.assets).toEqual([asset]);
 // The current frozen-identity policy still prevents deleting an approved asset again.
 expect(session.historyEdit("redo", "redo", 2, "user").stage).toBe("refused");
});

it("does not allow duplicate identities to shadow an approved asset", () => {
 const approved = { id: "p", kind: "product", name: "Item", approval: { name: "Item" } };
 const session = new ProjectSession("audit", { assets: [approved] });
 expect(session.submit(edit("shadow", 0, [{kind: "insert", path: ["assets"], index: 1, value: { id: "p", kind: "product", name: "Forged" }}])).stage).toBe("refused");
 expect(session.snapshot().document.assets).toEqual([approved]);
});

it("protects every asset creation shape including direct inserts and amendments", () => {
  const product = { id: "p", kind: "product", name: "Item", approval: { name: "Item" } };
  for (const operation of [set(["assets"], [product]), { kind: "insert" as const, path: ["assets"], index: 0, value: product }]) {
    const session = new ProjectSession("audit", { assets: [] as typeof product[] });
    expect(session.submit(edit("forged", 0, [operation])).stage).toBe("refused");
    expect(() => session.amend({ assets: [product] })).toThrow(/approval endpoint/);
  }
});

it("rejects approval imports, preserves existing legacy records and refuses colliding approval ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-trust-boundary-"));
  try {
    const store = new FileSessionStore(dir), draft = { id: "p", kind: "product", name: "Item" };
    const approved = { ...draft, approval: { name: "Item" } };
    expect(() => store.open("audit", { id: "audit", assets: [approved] })).toThrow(/Imported approvals/);
    expect(fs.readdirSync(dir).filter(file => file.endsWith(".json"))).toEqual([]);
    store.open("audit", { id: "audit", assets: [draft] });
    const claimed = { ...edit("claim", 0, []), intent: "批准商品 p" };
    expect(store.apply("audit", claimed).receipt.stage).toBe("verified");
    let invoked = false;
    const request = { id: claimed.id, baseRevision: 0, actor: "user" as const, scope: {}, intent: claimed.intent };
    expect(new FileSessionStore(dir).approveAsset("audit", request, () => { invoked = true; return [set(["assets", "0"], approved)]; }).receipt.stage).toBe("refused");
    expect(invoked).toBe(false);
    const { projectId: _, operations: __, ...trusted } = edit("approve", 1, []);
    expect(store.approveAsset("audit", trusted, () => [set(["assets", "0"], approved)]).receipt.stage).toBe("verified");
    expect(new FileSessionStore(dir).approveAsset("audit", trusted, () => { throw new Error("must not execute on retry"); }).receipt.stage).toBe("verified");
    const file = path.join(dir, `${createHash("sha256").update("audit").digest("hex")}.json`);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    delete envelope.state.history[1].approvalOrigin;
    envelope.checksum = createHash("sha256").update(canonicalJson(envelope.state)).digest("hex");
    fs.writeFileSync(file, JSON.stringify(envelope));
    const legacy = new FileSessionStore(dir);
    expect(legacy.snapshot("audit").snapshot.document.assets).toEqual([approved]);
    expect(legacy.open("audit", { id: "audit", assets: [approved] }).conflict).toBe(false);
    expect(legacy.approveAsset("audit", trusted, () => { throw new Error("must not run"); }).receipt.stage).toBe("refused");
    expect(legacy.historyEdit("audit", "undo", "undo", 2, "user").receipt.stage).toBe("verified");
    expect(legacy.historyEdit("audit", "redo", "redo", 3, "user").receipt.stage).toBe("verified");
    // The pre-marker schema has no reliable way to distinguish a trusted approval
    // from an ordinary transaction, even if its intent and ID are identical.
    const oldFile = path.join(dir, `${createHash("sha256").update("old").digest("hex")}.json`);
    const oldTransaction = { ...claimed, projectId: "old" };
    const oldState = { projectId: "old", revision: 1, document: { id: "old", assets: [draft] }, history: [{ revision: 1, transaction: oldTransaction, inverse: [], digest: "legacy", action: "edit", changed: false }], selection: [] };
    fs.writeFileSync(oldFile, JSON.stringify({ version: 1, checksum: createHash("sha256").update(canonicalJson(oldState)).digest("hex"), state: oldState }));
    const oldStore = new FileSessionStore(dir);
    expect(oldStore.snapshot("old").snapshot.revision).toBe(1);
    expect(oldStore.approveAsset("old", request, () => { throw new Error("must not run"); }).receipt.stage).toBe("refused");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("documents that a same-user writer can recompute the checksum and forge history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-untrusted-journal-"));
  try {
    const store = new FileSessionStore(dir), draft = { id: "p", kind: "product", name: "Item" };
    const forged = { ...draft, approval: { name: "Item" } };
    store.open("audit", { id: "audit", assets: [draft] });
    const file = path.join(dir, `${createHash("sha256").update("audit").digest("hex")}.json`);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.state.revision = 1;
    envelope.state.history = [{ revision: 1, transaction: edit("forged", 0, [set(["assets", "0"], draft)]), inverse: [set(["assets", "0"], forged)], digest: "forged", action: "edit", changed: true }];
    envelope.checksum = createHash("sha256").update(canonicalJson(envelope.state)).digest("hex");
    fs.writeFileSync(file, JSON.stringify(envelope));
    // This is intentionally a documented trust boundary, not a security guarantee.
    expect(new FileSessionStore(dir).historyEdit("audit", "undo", "u", 1, "user").receipt.stage).toBe("verified");
    expect(new FileSessionStore(dir).snapshot("audit").snapshot.document.assets).toEqual([forged]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("rejects ordinary new approvals and preserves trusted and legacy approval history across disk restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-security-session-"));
  try {
    const store = new FileSessionStore(dir), draft = { id: "p", kind: "product", name: "Item" }, approved = { ...draft, approval: { name: "Item" } };
    store.open("audit", { id: "audit", assets: [draft] });
    const ops = [set(["assets", "0"], approved)];
    expect(store.apply("audit", edit("forged", 0, ops)).receipt.stage).toBe("refused");
    const { projectId: _, operations: __, ...request } = edit("approve", 0, ops);
    expect(store.approveAsset("audit", request, () => ops).receipt.stage).toBe("verified");
    const restart = new FileSessionStore(dir);
    expect(restart.apply("audit", edit("attack", 1, [set(["assets", "0", "name"], "changed")])).receipt.stage).toBe("refused");
    expect(restart.historyEdit("audit", "undo", "undo", 1, "user").receipt.stage).toBe("verified");
    expect(new FileSessionStore(dir).historyEdit("audit", "redo", "redo", 2, "user").receipt.stage).toBe("verified");
    expect(new FileSessionStore(dir).snapshot("audit").snapshot.document.assets).toEqual([approved]);
    const legacy = new ProjectSession("legacy", { assets: [approved] });
    expect(legacy.snapshot().document.assets).toEqual([approved]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
