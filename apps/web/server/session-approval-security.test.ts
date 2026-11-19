import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
// @ts-expect-error server is JavaScript
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("rejects approval through generic HTTP edits and only pins via the approval endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-security-http-")), media = path.join(root, "media");
  fs.mkdirSync(media);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(media, "item.png"), bytes);
  const project = parseProject({ schemaVersion: 1, id: "audit-http", title: "审核", aspect: "16:9", knowledgeSources: [], assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] }], scenes: [{ id: "one", kind: "title", title: "一", narration: { text: "一句" } }] });
  const sessions = path.join(root, "sessions"), store = new FileSessionStore(sessions, value => { parseProject(value); });
  store.open(project.id, project);
  const server = createWebServer({ mediaJobs: createMediaJobs(media, {}), sessionStore: store, requestLogDir: path.join(root, "logs") });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session/`;
    const send = (action: string, body: unknown) => fetch(base + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const actor of ["user", "skill", "cli", "product-agent"]) {
      const transaction = { id: `attack-${actor}`, projectId: project.id, baseRevision: 0, actor, scope: {}, intent: "attack", operations: [{ kind: "set", path: ["assets", "0", "approval"], value: { name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] } }] };
      expect((await send("apply", { projectId: project.id, transaction })).status).toBe(409);
    }
    expect(store.snapshot(project.id).look.revision).toBe(0);
    for (const kind of ["character", "product"] as const) {
      const fake = { id: `fake-${kind}`, kind, name: "伪造", version: "v1", description: "伪造", ...(kind === "character" ? { voice: "voice" } : {}), refs: ["assets/not-pinned.png"], approval: { name: "伪造", version: "v1", description: "伪造", ...(kind === "character" ? { voice: "voice" } : {}), refs: ["assets/not-pinned.png"] } };
      const imported = { ...project, id: `import-${kind}`, assets: [fake] };
      const refused = await send("open", { projectId: imported.id, project: imported });
      expect(refused.status).toBe(409); expect((await refused.json()).code).toBe("untrusted-import");
      expect(() => store.snapshot(imported.id)).toThrow(/not found/i);
    }
    const hashForImport = createHash("sha256").update(bytes).digest("hex");
    const forgedRef = `assets/approved-${hashForImport}.png`;
    const forgedPinned = { ...project.assets![0]!, refs: [forgedRef], approval: { name: "商品", version: "v1", description: "红色", refs: [forgedRef], refSha256: hashForImport } };
    expect((await send("open", { projectId: "import-pinned", project: { ...project, id: "import-pinned", assets: [forgedPinned] } })).status).toBe(409);
    const claimed = { id: "claimed", projectId: project.id, baseRevision: 0, actor: "user", scope: {}, intent: "批准商品 item", operations: [] };
    expect((await send("apply", { projectId: project.id, transaction: claimed })).status).toBe(200);
    expect((await send("approve-product", { projectId: project.id, assetId: "item", transactionId: "claimed", baseRevision: 0 })).status).toBe(409);
    expect(new FileSessionStore(sessions).snapshot(project.id).snapshot.document.assets).toEqual(project.assets);
    const body = { projectId: project.id, assetId: "item", transactionId: "approve", baseRevision: 1 };
    expect((await send("approve-product", body)).status).toBe(200);
    expect((await send("approve-product", body)).status).toBe(200);
    const hash = createHash("sha256").update(bytes).digest("hex"), restarted = new FileSessionStore(sessions, value => { parseProject(value); });
    const saved = restarted.snapshot(project.id).snapshot.document as typeof project;
    expect(saved.assets![0]!.approval?.refSha256).toBe(hash);
    expect(fs.readFileSync(path.join(media, `approved-${hash}.png`))).toEqual(bytes);
    expect((await send("undo", { projectId: project.id, transactionId: "undo", baseRevision: 2, actor: "user" })).status).toBe(200);
    expect((await send("redo", { projectId: project.id, transactionId: "redo", baseRevision: 3, actor: "user" })).status).toBe(200);
    expect((new FileSessionStore(sessions).snapshot(project.id).snapshot.document as typeof project).assets![0]!.approval?.refSha256).toBe(hash);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
