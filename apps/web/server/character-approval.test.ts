import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
// @ts-expect-error JS server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("pins the approved bytes with a durable revision, detects conflicts and recovers the same transaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-pin-approval-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(media, "hero.png"), image);
  const project = parseProject({ schemaVersion: 1, id: "approval-test", title: "测试", aspect: "16:9", knowledgeSources: [], assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-a", refs: ["assets/hero.png"] }], scenes: [{ id: "one", kind: "title", title: "一", narration: { text: "一句" } }] });
  const sessions = path.join(root, "sessions"), store = new FileSessionStore(sessions, value => { parseProject(value); }); store.open(project.id, project);
  const jobs = createMediaJobs(media, {}), server = createWebServer({ mediaJobs: jobs, sessionStore: store, requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session/approve-character`;
    const send = (payload: unknown) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = { projectId: project.id, assetId: "hero", transactionId: "approve-1", baseRevision: 0 };
    const [first, stale] = await Promise.all([send(body), send({ ...body, transactionId: "approve-2" })]);
    expect([first.status, stale.status].sort()).toEqual([200, 409]);
    const successful = first.status === 200 ? body : { ...body, transactionId: "approve-2" };
    const hash = createHash("sha256").update(image).digest("hex"), pinned = `approved-${hash}.png`;
    const snapshot = store.snapshot(project.id).snapshot.document as typeof project;
    expect(snapshot.assets![0]!.approval).toMatchObject({ refSha256: hash, refs: [`assets/${pinned}`] });
    expect(snapshot.scenes).toEqual(project.scenes); expect(fs.readFileSync(path.join(media, pinned))).toEqual(image);
    expect(fs.readdirSync(media).filter(name => name.startsWith("approved-"))).toEqual([pinned]);
    expect((await send(successful)).status).toBe(200);
    expect(store.snapshot(project.id).look.revision).toBe(1);
    expect((await send({ ...successful, assetId: "wrong" })).status).toBe(409);
    const crossKind = await fetch(endpoint.replace("approve-character", "approve-product"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(successful) });
    expect(crossKind.status).toBe(409); expect(store.snapshot(project.id).look.revision).toBe(1);
    const restarted = new FileSessionStore(sessions, value => { parseProject(value); });
    expect(restarted.snapshot(project.id).snapshot.document).toEqual(snapshot);
    const undone = restarted.historyEdit(project.id, "undo", "undo-approval", 1, "user");
    expect(undone.receipt.stage).toBe("verified"); expect((undone.snapshot.document as typeof project).assets![0]!.approval).toBeUndefined();
    const redone = restarted.historyEdit(project.id, "redo", "redo-approval", 2, "user");
    expect(redone.receipt.stage).toBe("verified"); expect((redone.snapshot.document as typeof project).assets![0]!.approval?.refSha256).toBe(hash);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});

it("deduplicates identical pinned content and cleans staged data on conflicts or write failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-pin-failure-"));
  try {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(path.join(root, "hero.png"), bytes); const jobs = createMediaJobs(root, {});
    const first = jobs.pinReference("hero.png"), second = jobs.pinReference("hero.png");
    expect(second).toEqual(first); expect(fs.readFileSync(path.join(root, first.name))).toEqual(bytes);
    fs.writeFileSync(path.join(root, first.name), "tampered");
    expect(() => jobs.pinReference("hero.png")).toThrow(/损坏或被替换/);
    expect(fs.readFileSync(path.join(root, first.name), "utf8")).toBe("tampered");
    expect(fs.readdirSync(root).some(name => name.endsWith(".part"))).toBe(false);
    fs.unlinkSync(path.join(root, first.name));
    const spy = vi.spyOn(fs, "linkSync").mockImplementation(() => { throw new Error("test link failure"); });
    try { expect(() => jobs.pinReference("hero.png")).toThrow(/test link failure/); } finally { spy.mockRestore(); }
    expect(fs.readdirSync(root).some(name => name.endsWith(".part"))).toBe(false);
    expect(fs.existsSync(path.join(root, first.name))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


it("approves products without a voice and rejects wrong-kind or conflicting retries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-product-approval-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"); fs.writeFileSync(path.join(media, "item.png"), bytes);
  const project = parseProject({ schemaVersion: 1, id: "product-test", title: "商品", aspect: "16:9", knowledgeSources: [], assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] }], scenes: [{ id: "one", kind: "title", title: "一", narration: { text: "一句", voice: "original" } }] });
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }); store.open(project.id, project);
  const server = createWebServer({ mediaJobs: createMediaJobs(media, {}), sessionStore: store, requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session/approve-`;
    const body = { projectId: project.id, assetId: "item", transactionId: "product-1", baseRevision: 0 };
    const send = (kind: string, data: unknown) => fetch(base + kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    expect((await send("character", body)).status).not.toBe(200); expect(store.snapshot(project.id).look.revision).toBe(0);
    expect((await send("product", body)).status).toBe(200); expect((await send("product", body)).status).toBe(200);
    expect((await send("character", body)).status).toBe(409);
    expect((await send("product", { ...body, assetId: "other" })).status).toBe(409);
    const snapshot = store.snapshot(project.id).snapshot.document as typeof project;
    expect(snapshot.assets![0]!.approval?.refSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(snapshot.scenes).toEqual(project.scenes); expect(store.snapshot(project.id).look.revision).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
