import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { runCreationPacks } from "../../studio/scripts/creation-packs-cli";
import { createSkillRuntime } from "./skill-runtime";
import { diffProject } from "../src/session-client";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** A Skill writes plain SceneScript; the software must open it and hand it back as a pack. */
it("opens a Skill-written project in the shared session and returns it as a reusable pack", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-handoff-")); roots.push(root);
  const skillProject = path.join(root, "skill-project.json"), exported = path.join(root, "pack.json"), reused = path.join(root, "reused.json");
  fs.writeFileSync(skillProject, JSON.stringify({
    schemaVersion: 1, id: "skill-made", title: "Skill 作品", aspect: "9:16", knowledgeSources: [],
    scenes: [
      { id: "hook", kind: "title", title: "开场钩子", narration: { text: "第一镜", durationMs: 1500 } },
      { id: "proof", kind: "bullets", heading: "证据", items: ["一", "二"], narration: { text: "第二镜", durationMs: 2200 } },
    ],
  }));
  const store = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  store.open("skill-made", JSON.parse(fs.readFileSync(skillProject, "utf8")));
  const opened = store.snapshot("skill-made").snapshot.document;
  expect(opened.title).toBe("Skill 作品");
  expect(opened.scenes).toHaveLength(2);
  expect(store.list()[0]!.projectId).toBe("skill-made");

  fs.writeFileSync(path.join(root, "software.json"), JSON.stringify(opened));
  runCreationPacks([`--export-project=${path.join(root, "software.json")}`, `--out=${exported}`, "--author=Skill owner", "--license=Personal only", "--confirm-rights"]);
  runCreationPacks([`--source=${exported}`, `--out=${reused}`]);
  const roundtrip = parseProject(JSON.parse(fs.readFileSync(reused, "utf8")));
  expect(roundtrip.scenes.map(scene => scene.id)).toEqual(["hook", "proof"]);
  expect(roundtrip.title).toBe("Skill 作品");
  expect(roundtrip.creationPack).toMatchObject({ id: expect.stringMatching(/^creation-/), version: "1.0.0" });
  expect(roundtrip.id).not.toBe("skill-made");
});

/** CORE-09 fixture scaffolding: a declared skill whose real child process emits a projectPatch. */
function skillFixture(root: string, projectId: string, patch: Record<string, unknown>) {
  const dir = path.join(root, "skills", "mcp-editor");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { "mcp-editor": { computedHash: "a".repeat(64) } } }));
  fs.writeFileSync(path.join(dir, "glint.skill.json"), JSON.stringify({ entry: "run.mjs", outputs: ["projectPatch"], timeoutMs: 30000 }));
  fs.writeFileSync(path.join(dir, "run.mjs"), `const chunks=[];for await(const c of process.stdin)chunks.push(c);JSON.parse(Buffer.concat(chunks).toString("utf8"));process.stdout.write(JSON.stringify(${JSON.stringify({ projectPatch: patch })})+"\\n");`);
  return createSkillRuntime({ repoRoot: root, dataDir: path.join(root, "data"), env: process.env, parseProject });
}

it("CORE-09: a Skill receipt patch lands in the session domain, visible and undoable from the studio", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-core09-")); roots.push(root);
  const base = {
    schemaVersion: 1, id: "shared-1", title: "共同工程", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "hook", kind: "title", title: "开场", narration: { text: "第一镜", durationMs: 1500 } }],
  };
  const store = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  store.open("shared-1", base);
  const patch = { ...structuredClone(base), title: "技能改写", scenes: [{ id: "hook", kind: "title", title: "技能改写开场", narration: { text: "技能改写旁白", durationMs: 1800 } }] };
  const receipt = await skillFixture(root, "shared-1", patch).run({ skill: "mcp-editor", grants: { project: true } });
  expect(receipt.ok).toBe(true);
  expect(() => parseProject(receipt.projectPatch)).not.toThrow();

  // External entry applies through the session lane, not by rewriting files.
  const before = store.snapshot("shared-1");
  const patchDoc = parseProject(receipt.projectPatch!);
  const { operations, preconditions } = diffProject(before.snapshot.document, patchDoc);
  const transactionId = `skill-${receipt.runId}`;
  const applied = store.apply("shared-1", { id: transactionId, projectId: "shared-1", baseRevision: before.look.revision, actor: "skill", scope: {}, operations, preconditions, intent: "Skill 回执入会话域" });
  expect(applied.receipt).toMatchObject({ stage: "verified", verification: "document-readback" });
  expect(applied.snapshot.document.title).toBe("技能改写");
  expect(applied.look.revision).toBe(before.look.revision + 1);

  // The journal records the external actor on the exact transaction.
  const journalFile = path.join(store.directory, `${createHash("sha256").update("shared-1").digest("hex")}.json`);
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  expect(journal.state.history.at(-1)).toMatchObject({ transaction: { id: transactionId, actor: "skill" } });

  // Studio side sees the change and undoes it; the receipt survives as history.
  const undone = store.historyEdit("shared-1", "undo", "studio-undo-1", applied.look.revision, "user");
  expect(undone.receipt.stage).toBe("verified");
  expect(undone.snapshot.document.title).toBe("共同工程");
  expect(store.verify("shared-1", transactionId).stage).toBe("saved");
});

it("CORE-09: CLI/MCP semantic edits ride applyTransform under the session lock and stay undoable", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-core09-cli-")); roots.push(root);
  const base = {
    schemaVersion: 1, id: "shared-2", title: "待命名", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "hook", kind: "title", title: "开场", narration: { text: "旁白", durationMs: 1500 } }],
  };
  const store = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  store.open("shared-2", base);
  const revision = store.snapshot("shared-2").look.revision;
  const applied = store.applyTransform("shared-2", { id: "mcp-rename-1", baseRevision: revision, actor: "cli", scope: {}, intent: "MCP 语义编辑" }, () => [{ kind: "set", path: ["title"], value: "MCP 命名" }]);
  expect(applied.receipt).toMatchObject({ stage: "verified", transactionId: "mcp-rename-1" });
  expect(applied.snapshot.document.title).toBe("MCP 命名");
  // Retrying the same tool call id never runs the edit twice.
  const retried = store.applyTransform("shared-2", { id: "mcp-rename-1", baseRevision: applied.look.revision, actor: "cli", scope: {}, intent: "MCP 语义编辑" }, () => { throw new Error("must not recompute"); });
  expect(retried.snapshot.document.title).toBe("MCP 命名");
  const undone = store.historyEdit("shared-2", "undo", "studio-undo-2", applied.look.revision, "user");
  expect(undone.receipt.stage).toBe("verified");
  expect(undone.snapshot.document.title).toBe("待命名");
});

it("CORE-09: a direct file write outside the session is refused as external-change and recovery restores the session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-core09-file-")); roots.push(root);
  const base = {
    schemaVersion: 1, id: "shared-3", title: "原始", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "hook", kind: "title", title: "开场", narration: { text: "旁白", durationMs: 1500 } }],
  };
  const projectFile = path.join(root, "shared-3.json");
  fs.writeFileSync(projectFile, JSON.stringify(base));
  const store = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  store.open("shared-3", base, projectFile);
  // An MCP file-lane writer bypasses the session: the session domain must refuse it.
  fs.writeFileSync(projectFile, JSON.stringify({ ...base, title: "绕过会话的直写" }));
  expect(() => store.snapshot("shared-3")).toThrow(/outside Glint/);
  // Recovery: restore the exported session revision and the session opens again.
  fs.writeFileSync(projectFile, JSON.stringify(base));
  expect(store.snapshot("shared-3").snapshot.document.title).toBe("原始");
});
