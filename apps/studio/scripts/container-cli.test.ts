import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateDocumentToContainer } from "@glintai/scenescript/project-container";
import { createProjectContainerStore } from "../../web/server/project-container-session";
const { createWebServer } = await import(new URL("../../web/server/index.mjs", import.meta.url).href) as { createWebServer(options: Record<string, unknown>): Server };
import { runContainer } from "./container-cli";
import { CONTAINER_REQUEST_LIMIT } from "./container-api-client";

let root: string, server: Server | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "container-cli-")); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } fs.rmSync(root, { recursive: true, force: true }); });
const write = (name: string, value: unknown) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
it("prints structured errors for missing endpoint, credential flags, malformed/oversized files", async () => {
  const lines: string[] = [], output = (line: string) => lines.push(line);
  expect(await runContainer(["snapshot", "--id=work"], {}, output)).toBe(2);
  expect(JSON.parse(lines.pop()!).error).toBe("endpoint-required");
  expect(await runContainer(["snapshot", "--id=work", "--token=SECRET"], {}, output)).toBe(2);
  expect(lines.pop()).not.toContain("SECRET");
  const env = { GLINT_CONTAINER_ENDPOINT: "http://127.0.0.1:1" };
  const file = write("request.json", "x".repeat(CONTAINER_REQUEST_LIMIT));
  expect(await runContainer(["append", `--request=${file}`], env, output)).toBe(2);
  expect(JSON.parse(lines.pop()!).error).toBe("request-too-large");
  fs.writeFileSync(file, "{");
  expect(await runContainer(["append", `--request=${file}`], env, output)).toBe(2);
  expect(JSON.parse(lines.pop()!).error).toBe("invalid-request-file");
});
it("rejects a non-regular request file before reading", async () => {
  const lines: string[] = [];
  // Windows NUL opens successfully but is not a regular disk file.
  const file = process.platform === "win32" ? "\\\\.\\NUL" : root;
  expect(await runContainer(["append", `--request=${file}`], { GLINT_CONTAINER_ENDPOINT: "http://127.0.0.1:1" }, line => lines.push(line))).toBe(2);
  expect(JSON.parse(lines[0]!).error).toBe("request-not-file");
});
it("drives open/append/history through the real CLI lazy route with bounded JSON failures", async () => {
  const token = "cli-fixture-only-token-more-than-24-characters";
  server = createWebServer({ basePath: "/app/", publicHost: "cli.test", accessToken: token, authRequired: true, requestLogDir: path.join(root, "logs"), projectContainerStoreFactory: () => createProjectContainerStore(path.join(root, "store")) });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/app`;
  const repo = path.resolve(import.meta.dirname, "../../.."), loader = createRequire(path.join(repo, "apps/web/package.json")).resolve("tsx");
  const cli = (args: string[], throughSkill = false) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const entry = throughSkill ? [path.join(repo, "skills/glint-video/scripts/glint.mjs"), `--root=${repo}`] : ["--import", pathToFileURL(loader).href, path.join(repo, "apps/studio/scripts/glint.ts")];
    const child = spawn(process.execPath, [...entry, "container", ...args], { cwd: root, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, GLINT_CONTAINER_ENDPOINT: endpoint, GLINT_ACCESS_TOKEN: token } });
    let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
    child.once("error", reject); child.once("close", code => resolve({ code, out, err }));
  });
  const scene = { schemaVersion: 1, id: "source", title: "原稿", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "shot", kind: "title", title: "原稿", narration: { text: "原稿", durationMs: 1000 } }] };
  const project = (await migrateDocumentToContainer(scene, { kind: "scene-document", projectId: "work", objectId: "doc", versionId: "v1", transactionId: "import", actor: "cli" })).container;
  write("skill-open.json", { projectId: "skill-work", project: { ...project, id: "skill-work" }, createOnly: true });
  const skillOpen = await cli(["open", "--request=skill-open.json"], true);
  expect(skillOpen.code).toBe(0); expect(JSON.parse(skillOpen.out).snapshot.projectId).toBe("skill-work");
  const open = await cli(["open", `--request=${write("open.json", { projectId: "work", project, createOnly: true })}`]);
  expect(open.err).toBe(""); expect(open.code).toBe(0); expect(JSON.parse(open.out).snapshot.revision).toBe(0);
  const firstPage = await cli(["list", "--limit=1"], true);
  expect(firstPage.code).toBe(0); expect(JSON.parse(firstPage.out)).toEqual({ projects: [{ projectId: "skill-work", revision: 0, title: "原稿", sceneCount: 1, timelineCount: 0, firstDocumentId: "doc" }], nextCursor: "skill-work" });
  const secondPage = await cli(["list", "--limit=1", "--cursor=skill-work"]);
  expect(secondPage.code).toBe(0); expect(JSON.parse(secondPage.out)).toMatchObject({ projects: [{ projectId: "work" }], nextCursor: null });
  expect(firstPage.out + secondPage.out).not.toContain(token);
  const body = { projectId: "work", transaction: { id: "edit", baseRevision: 0, actor: "cli", scope: {}, intent: "编辑" }, changes: [{ objectId: "doc", versionId: "v2", payload: { ...scene, title: "更新" } }] };
  const append = await cli(["append", `--request=${write("append.json", body)}`, `--endpoint=${endpoint}/`]);
  expect(append.code).toBe(0); expect(JSON.parse(append.out).receipt.transactionId).toBe("edit");
  const stale = await cli(["append", `--request=${write("stale.json", { ...body, transaction: { ...body.transaction, id: "stale" } })}`]);
  expect(stale.code).toBe(2); expect(JSON.parse(stale.out).result.receipt.stage).toBe("refused");
  for (const [action, baseRevision] of [["undo", 1], ["redo", 2]] as const) {
    const result = await cli([action, `--request=${write(action + ".json", { projectId: "work", transactionId: action, baseRevision, actor: "cli" })}`]);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).snapshot.revision).toBe(baseRevision + 1);
  }
  const snapshot = await cli(["snapshot", "--id=work"]);
  expect(snapshot.code).toBe(0); expect(JSON.parse(snapshot.out).snapshot.revision).toBe(3); expect(snapshot.out + snapshot.err).not.toContain(token);
  const migrated = await cli(["migrate-copy", `--request=${write("migrate.json", { projectId: "work-v2", sourceProjectId: "work" })}`]);
  expect(migrated.code).toBe(0); expect(JSON.parse(migrated.out).snapshot.document.version).toBe(2);
  expect(JSON.parse(migrated.out).snapshot.document.migration).toMatchObject({ sourceProjectId: "work" });
  const lifecycle = await cli(["lifecycle", `--request=${write("lifecycle.json", { projectId: "work-v2", transaction: { id: "add-script", baseRevision: 0, actor: "cli", scope: {}, intent: "添加脚本" }, change: { action: "add", objectId: "script", versionId: "script-v1", kind: "script-document", payload: { id: "script-doc", title: "脚本", kind: "script", content: "", updatedAt: 0 } } })}`]);
  expect(lifecycle.code).toBe(0); expect(JSON.parse(lifecycle.out).receipt.stage).toBe("verified");
  const staleLifecycle = await cli(["lifecycle", `--request=${write("stale-lifecycle.json", { projectId: "work-v2", transaction: { id: "stale-add", baseRevision: 0, actor: "cli", scope: {}, intent: "过期" }, change: { action: "archive", objectId: "script" } })}`]);
  expect(staleLifecycle.code).toBe(2); expect(JSON.parse(staleLifecycle.out).result.receipt.stage).toBe("refused");
}, 30000);

it("rejects list flags outside pagination and validates limits before HTTP", async () => {
  const env = { GLINT_CONTAINER_ENDPOINT: "http://127.0.0.1:1" };
  for (const flags of [["--limit=0"], ["--limit=51"], ["--limit=1.5"], ["--limit=1", "--limit=2"], ["--cursor=../bad"], ["--token=SECRET"], ["--id=work"], ["--request=x.json"]]) {
    const lines: string[] = []; expect(await runContainer(["list", ...flags], env, line => lines.push(line))).toBe(2);
    expect(JSON.parse(lines[0]!).error).not.toBe("transport-failed"); expect(lines[0]).not.toContain("SECRET");
  }
});