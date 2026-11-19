// TEAM-09 批准冻结：真实 HTTP 服务器上的双入口演示——
// user 入口冻结/解冻；skill 入口在冻结期被 409 拒绝；解冻后恢复可用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
// @ts-expect-error JavaScript server module, exercised over real HTTP.
import { createWebServer } from "../server/index.mjs";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const project = { schemaVersion: 1, id: "freeze-http-demo", title: "批准冻结", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "scene-1", kind: "title", title: "原始", narration: { text: "旁白" } }] };
const tx = (id: string, actor: string, baseRevision: number, operations: unknown[], intent: string) => ({ id, projectId: project.id, baseRevision, actor, scope: {}, operations, intent });

it("reserves a new session atomically and refuses existing IDs without changing their bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glint-create-only-")); directories.push(directory);
  const server = createWebServer({ sessionStore: new FileSessionStore(directory, document => { parseProject(document); }) }) as Server;
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (doc: typeof project) => fetch(`${base}/api/session/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: doc.id, project: doc, createOnly: true }) });
  const first = await post(project); expect(first.status).toBe(200);
  const before = fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(file => file.endsWith(".json"))!));
  const conflict = await post({ ...project, title: "不得覆盖" }); expect(conflict.status).toBe(409); expect((await conflict.json()).code).toBe("project-conflict");
  const identical = await post(project); expect(identical.status).toBe(409);
  expect(fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(file => file.endsWith(".json"))!))).toEqual(before);
  const seen = await (await fetch(`${base}/api/session/snapshot?projectId=${project.id}`)).json(); expect(seen.snapshot.document.title).toBe(project.title);
  const raced = { ...project, id: "race-create" };
  const responses = await Promise.all([post(raced), post({ ...raced, title: "另一个" })]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
}, 30_000);

it("demonstrates approval freeze across two HTTP entries: freeze, 409 refusals, owner-only unfreeze", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glint-freeze-http-")); directories.push(directory);
  const server = createWebServer({ sessionStore: new FileSessionStore(directory, document => { parseProject(document); }) }) as Server;
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (pathname: string, body: unknown) => fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // 入口一（user）：打开工程并冻结。
  expect((await post("/api/session/open", { projectId: project.id, project })).status).toBe(200);
  const freeze = await (await post("/api/session/apply", { projectId: project.id, transaction: tx("user-freeze", "user", 0, [{ kind: "set", path: ["frozen"], value: true }], "批准冻结") })).json();
  expect(freeze.receipt.stage).toBe("verified");
  expect(freeze.project.frozen).toBe(true);

  // 入口二（skill，独立 HTTP 调用）：读到冻结态，编辑被 409 拒绝。
  const seen = await (await fetch(`${base}/api/session/snapshot?projectId=${encodeURIComponent(project.id)}`)).json();
  expect(seen.snapshot.document.frozen).toBe(true);
  const skillEdit = await post("/api/session/apply", { projectId: project.id, transaction: tx("skill-edit-1", "skill", freeze.look.revision, [{ kind: "set", path: ["scenes", "0", "title"], value: "越权修改" }], "skill 入口") });
  expect(skillEdit.status).toBe(409);
  const skillBody = await skillEdit.json();
  expect(skillBody.receipt.stage).toBe("refused");
  expect(skillBody.receipt.reason).toContain("frozen");

  // 冻结期内 user 的普通编辑同样被拒；解冻必须是 user 的单操作。
  const ownerEdit = await post("/api/session/apply", { projectId: project.id, transaction: tx("user-edit-1", "user", freeze.look.revision, [{ kind: "set", path: ["title"], value: "冻结期改题" }], "user 普通编辑") });
  expect(ownerEdit.status).toBe(409);
  const bundledUnfreeze = await post("/api/session/apply", { projectId: project.id, transaction: tx("user-unfreeze-bundled", "user", freeze.look.revision, [{ kind: "set", path: ["frozen"], value: false }, { kind: "set", path: ["title"], value: "搭车改题" }], "捆绑解冻") });
  expect(bundledUnfreeze.status).toBe(409);
  const foreignUnfreeze = await post("/api/session/apply", { projectId: project.id, transaction: tx("skill-unfreeze", "skill", freeze.look.revision, [{ kind: "set", path: ["frozen"], value: false }], "skill 解冻") });
  expect(foreignUnfreeze.status).toBe(409);

  // 入口一（user）单操作解冻，入口二随之恢复可用。
  const unfreeze = await post("/api/session/apply", { projectId: project.id, transaction: tx("user-unfreeze", "user", freeze.look.revision, [{ kind: "set", path: ["frozen"], value: false }], "批准解冻") });
  expect(unfreeze.status).toBe(200);
  expect((await unfreeze.json()).project.frozen).toBe(false);
  const after = await post("/api/session/apply", { projectId: project.id, transaction: tx("skill-edit-2", "skill", freeze.look.revision + 1, [{ kind: "set", path: ["scenes", "0", "title"], value: "解冻后修改" }], "skill 入口") });
  expect(after.status).toBe(200);
  expect((await after.json()).receipt.stage).toBe("verified");
}, 30_000);
