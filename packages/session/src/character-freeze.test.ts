import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectSession, type EditTransaction, type SessionState } from "./index";
import { FileSessionStore } from "./node";

const roots: string[] = []; afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const character = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝衣", voice: "voice-a", refs: ["assets/hero.png"] };
const approved = { ...character, approval: { name: character.name, version: character.version, description: character.description, voice: character.voice, refs: character.refs } };
const document = () => ({ id: "demo", assets: [character], scenes: [{ id: "one", narration: { text: "台词" } }] });
const transaction = (id: string, baseRevision: number, actor: EditTransaction["actor"], operations: EditTransaction["operations"]): EditTransaction => ({ id, projectId: "demo", baseRevision, actor, scope: {}, intent: id, operations });

it("blocks removing approval and changing identity in one transaction for all actors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-character-session-")); roots.push(dir);
  const store = new FileSessionStore(dir); store.open("demo", document());
  const request = { id: "approve", baseRevision: 0, actor: "user" as const, scope: {}, intent: "approve" };
  expect(store.approveAsset("demo", request, () => [{ kind: "set", path: ["assets", "0", "approval"], value: approved.approval }]).receipt.stage).toBe("verified");
  // Reconstruct the persisted journal for the pure-domain mutation checks.
  const envelopeFile = fs.readdirSync(dir).find(file => file.endsWith(".json"))!;
  const saved = (JSON.parse(fs.readFileSync(path.join(dir, envelopeFile), "utf8")) as { state: SessionState<ReturnType<typeof document>> }).state;
  const session = new ProjectSession(saved.projectId, saved.document, saved.revision, saved.history);
  for (const actor of ["user", "product-agent", "skill", "cli"] as const) {
    const result = session.submit(transaction(`bypass-${actor}`, 1, actor, [
      { kind: "delete", path: ["assets", "0", "approval"] }, { kind: "set", path: ["assets", "0", "voice"], value: "other" },
    ]));
    expect(result.stage).toBe("refused"); expect(result.reason).toContain("frozen");
  }
  expect(session.submit(transaction("delete", 1, "user", [{ kind: "delete", path: ["assets", "0"] }])).stage).toBe("refused");
  expect(() => session.amend({ ...document(), assets: [{ ...character, voice: "other" }] })).toThrow(/frozen/);
  expect(session.snapshot().document.assets[0]).toEqual(approved);
  expect(session.historyEdit("undo", "undo", 1, "user").stage).toBe("dispatched");
  expect(session.snapshot().document.assets[0]).toEqual(character);
  expect(session.historyEdit("redo", "redo", 2, "user").stage).toBe("dispatched");
  expect(session.snapshot().document.assets[0]).toEqual(approved);
});
it.each(["character", "product"] as const)("protects approved %s from stale history and forged undo", kind => {
  const draft = { ...character, kind }, sealed = { ...draft, approval: { ...approved.approval } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-character-session-")); roots.push(dir);
  const store = new FileSessionStore(dir); store.open("demo", { ...document(), assets: [draft] });
  const oldEdit = transaction("old-edit", 0, "user", [{ kind: "set", path: ["assets", "0", "description"], value: "旧修改" }]);
  expect(store.apply("demo", oldEdit).receipt.stage).toBe("verified");
  const revised = { ...sealed, description: "旧修改", approval: { ...sealed.approval, description: "旧修改" } };
  expect(store.approveAsset("demo", { id: "approve", baseRevision: 1, actor: "user", scope: {}, intent: "approve" }, () => [{ kind: "set", path: ["assets", "0"], value: revised }]).receipt.stage).toBe("verified");
  const envelopeFile = fs.readdirSync(dir).find(file => file.endsWith(".json"))!;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, envelopeFile), "utf8")).state;
  // A stale state in which approval was non-undoable must still protect the asset.
  const legacyHistory = [saved.history[0], { ...saved.history[1], changed: false, transaction: { ...saved.history[1].transaction, id: "amend-2", operations: [] }, inverse: [] }];
  const session = new ProjectSession("demo", saved.document, saved.revision, legacyHistory);
  const snapshot = session.snapshot();
  expect(session.historyEdit("undo", "stale-undo", 2, "user").stage).toBe("refused");
  const forged = transaction("forged", 2, "user", [{ kind: "delete", path: ["assets", "0", "approval"] }, { kind: "set", path: ["assets", "0", "description"], value: "篡改" }]);
  expect(session.submit(forged, "undo", "old-edit").stage).toBe("refused");
  expect(session.snapshot()).toEqual(snapshot);
});

it("permits unrelated scene edits while an identity is frozen", () => {
  const session = new ProjectSession("demo", { ...document(), assets: [approved] });
  const result = session.submit(transaction("scene-edit", 0, "product-agent", [{ kind: "set", path: ["scenes", "0", "narration", "text"], value: "新台词" }]));
  expect(result.stage).toBe("dispatched"); expect(session.snapshot().document.scenes[0]!.narration.text).toBe("新台词");
  expect(session.snapshot().document.assets[0]).toEqual(approved);
});
it("restores approval, refusal and undo/redo after a store restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-character-session-")); roots.push(dir);
  const first = new FileSessionStore(dir); first.open("demo", document());
  expect(first.approveAsset("demo", { id: "approve", baseRevision: 0, actor: "user", scope: {}, intent: "approve" }, () => [{ kind: "set", path: ["assets", "0", "approval"], value: approved.approval }]).receipt.stage).toBe("verified");
  const restarted = new FileSessionStore(dir);
  expect(restarted.apply("demo", transaction("attack", 1, "cli", [{ kind: "set", path: ["assets", "0"], value: { ...character, voice: "other" } }])).receipt.stage).toBe("refused");
  expect(restarted.historyEdit("demo", "undo", "undo", 1, "user").receipt.stage).toBe("verified");
  expect(new FileSessionStore(dir).snapshot("demo").snapshot.document.assets).toEqual([character]);
  expect(restarted.historyEdit("demo", "redo", "redo", 2, "user").receipt.stage).toBe("verified");
  expect(new FileSessionStore(dir).snapshot("demo").snapshot.document.assets).toEqual([approved]);
});
