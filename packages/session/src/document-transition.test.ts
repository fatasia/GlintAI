import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileSessionStore } from "./node";
import { ProjectSession, type EditTransaction } from "./index";
import type { DocumentTransition } from "./document-transition";

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const tx = (id = "edit", baseRevision = 0): EditTransaction => ({ id, baseRevision, projectId: "work", actor: "user", intent: "edit", scope: {}, operations: [{ kind: "set", path: ["title"], value: "Changed" }] });

it("keeps live document, caller transaction and durable journal unchanged when policy throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-transition-")); roots.push(dir);
  const policy: DocumentTransition = (before, after, context) => {
    if (context.action === "import") return after;
    before!.title = "mutated"; after.title = "mutated"; context.transaction!.intent = "mutated";
    throw new Error("Policy refused");
  };
  const store = new FileSessionStore(dir, undefined, undefined, policy); store.open("work", { id: "work", title: "Original" });
  const file = path.join(dir, fs.readdirSync(dir)[0]!), bytes = fs.readFileSync(file), request = tx();
  expect(store.apply("work", request).receipt.stage).toBe("refused");
  expect(fs.readFileSync(file)).toEqual(bytes); expect(request.intent).toBe("edit");
  expect(store.snapshot("work").snapshot.document.title).toBe("Original");
});

it("does not let amend bypass policy or fake history actions reach it", () => {
  let calls = 0;
  const session = new ProjectSession("work", { id: "work", title: "Original" }, 0, [], [], undefined, false, (_before, after, context) => {
    calls++; if (context.action === "amend") throw new Error("No amendment"); return after;
  });
  expect(() => session.amend({ id: "work", title: "Bypass" })).toThrow("No amendment");
  expect(session.submit(tx(), "undo", "invented").stage).toBe("refused");
  expect(calls).toBe(1); expect(session.snapshot().revision).toBe(0);
  expect(session.submit(tx()).stage).toBe("dispatched");
});
