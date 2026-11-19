import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { sceneReworkContext } from "../src/scene-rework";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("publishes complete candidate copies and rejects tampered or conflicting copies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-adopt-publish-"));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const jobs = createMediaJobs(root, {}), sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(root, `adopted-${sha256}.png`), link = fs.linkSync.bind(fs);
  const spy = vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(bytes);
    return link(source, destination);
  });
  try { expect(jobs.adoptCandidate(bytes, "png")).toEqual({ name: path.basename(target), sha256 }); }
  finally { spy.mockRestore(); }
  expect(fs.readFileSync(target)).toEqual(bytes);
  expect(jobs.adoptCandidate(bytes, "png").sha256).toBe(sha256);
  fs.writeFileSync(target, "external change");
  expect(() => jobs.adoptCandidate(bytes, "png")).toThrow(/冲突或已变化/);
  expect(fs.readFileSync(target, "utf8")).toBe("external change");
  const fail = vi.spyOn(fs, "linkSync").mockImplementation(() => { throw new Error("publish failure"); });
  try { expect(() => jobs.adoptCandidate(Buffer.from(bytes).fill(0, 20, 21), "png")).toThrow(/publish failure/); }
  finally { fail.mockRestore(); }
  expect(fs.readdirSync(root).some(name => name.endsWith(".part"))).toBe(false);
});

it("checks actual approved bytes and task ownership within the same session transaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ref-adopt-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const hash = createHash("sha256").update(bytes).digest("hex"), ref = `approved-${hash}.png`; fs.writeFileSync(path.join(media, "hero.png"), bytes);
  const identity = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-1", refs: ["assets/hero.png"] };
  const draft = parseProject({ schemaVersion: 1, id: "adopt-project", title: "测试", aspect: "16:9", knowledgeSources: [], assets: [identity], scenes: [{ id: "one", kind: "image", src: "assets/original.png", assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: "镜头", durationMs: 1000 } }] });
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }); store.open(draft.id, draft);
  const imageFile = path.join(root, "candidate.png");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=32x32", "-frames:v", "1", imageFile], { timeout: 60000 });
  const candidateBytes = fs.readFileSync(imageFile);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }]), submit: vi.fn(async () => "task-ref"), status: vi.fn(async () => ({ task_id: "task-ref", state: "success", is_final: true, result_url: "https://asset.test/candidate.png" })) };
  const jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download: vi.fn(async () => ({ contentType: "image/png", bytes: candidateBytes })) });
  const server = createWebServer({ mediaJobs: jobs, sessionStore: store, modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")), mediaSettings: createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" } }), requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, value: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const approval = await post("/api/session/approve-character", { projectId: draft.id, assetId: "hero", transactionId: "approve-fixture", baseRevision: 0 });
    expect(approval.status).toBe(200);
    const project = parseProject((await approval.json()).snapshot.document);
    expect(project.assets![0]!.approval?.refSha256).toBe(hash);
    const basis = sceneReworkContext(project, "one").basis;
    // M-02b contract: the actual host only executes an explicitly quoted and approved input.
    const approved = await approveMediaInput(base, {
      type: "image", model: "edit", prompt: "小雨", params: {}, requestId: "reference-1",
      referenceImage: ref, referenceSha256: hash,
      referenceBinding: { projectId: project.id, sceneId: "one", assetId: "hero", basis, referenceImage: ref, sha256: hash },
    });
    expect((await post("/api/media/submit", { type: "image", model: "edit", prompt: "小雨", params: {}, requestId: "reference-1", reference: { projectId: project.id, sceneId: "one", assetId: "hero", basis }, bindingId: approved.bindingId, quoteId: approved.quoteId })).status).toBe(202);
    const status = await jobs.status("task-ref");
    expect(status.assetUrl).toBe("/api/media/assets/task-ref.png");
    expect(status).not.toHaveProperty("candidateReceipt");
    const file = path.join(media, "task-ref.json"), task = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(task.candidateReceipt).toEqual({ file: "task-ref.png", sha256: createHash("sha256").update(candidateBytes).digest("hex") });
    const body = { projectId: project.id, taskId: "task-ref", transactionId: "adopt-one", baseRevision: 1, mode: "replace" };
    fs.writeFileSync(path.join(media, "task-ref.png"), Buffer.concat([candidateBytes, Buffer.from([0])]));
    expect((await post("/api/session/adopt-reference-candidate", body)).status).toBe(400);
    expect(store.snapshot(project.id).snapshot.revision).toBe(1);
    fs.writeFileSync(path.join(media, "task-ref.png"), candidateBytes);
    fs.writeFileSync(file, JSON.stringify({ ...task, candidateReceipt: undefined }));
    expect((await post("/api/session/adopt-reference-candidate", body)).status).toBe(400);
    fs.writeFileSync(file, JSON.stringify(task));
    fs.writeFileSync(path.join(media, ref), Buffer.concat([bytes, Buffer.from([0])]));
    expect((await post("/api/session/adopt-reference-candidate", body)).status).toBe(400);
    expect(store.snapshot(project.id).snapshot.revision).toBe(1);
    fs.writeFileSync(path.join(media, ref), bytes);
    expect((await post("/api/session/adopt-reference-candidate", { ...body, projectId: "missing" })).status).toBe(404);
    expect((await post("/api/session/adopt-reference-candidate", { ...body, baseRevision: 9 })).status).toBe(409);
    const response = await post("/api/session/adopt-reference-candidate", body); expect(response.status, JSON.stringify((await response.clone().json()).error)).toBe(200);
    const adopted = await response.json();
    const adoptedName = `adopted-${createHash("sha256").update(candidateBytes).digest("hex")}.png`;
    expect(adopted.snapshot.document.scenes[0].src).toBe(`assets/${adoptedName}`);
    fs.writeFileSync(path.join(media, "task-ref.png"), Buffer.from("external replacement"));
    expect(fs.readFileSync(path.join(media, adoptedName))).toEqual(candidateBytes);
    expect(adopted.receipt.stage).toBe("verified");
    expect((await post("/api/session/adopt-reference-candidate", body)).status).toBe(200);
    expect(store.snapshot(project.id).snapshot.revision).toBe(2);
    expect((await post("/api/session/adopt-reference-candidate", { ...body, transactionId: "other", baseRevision: 2 })).status).toBe(400);
    const undo = await post("/api/session/undo", { projectId: project.id, transactionId: "undo-adopt", baseRevision: 2, actor: "user" });
    expect(undo.status).toBe(200); expect((await undo.json()).snapshot.document.scenes[0].src).toBe("assets/original.png");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);

it("rejects frozen reference projects before invoking the provider for characters and products", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ref-frozen-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex"); fs.writeFileSync(path.join(media, "ref.png"), bytes);
  const assets = ["character", "product"].map(kind => ({ id: kind, kind, name: kind, version: "v1", description: "测试资产", ...(kind === "character" ? { voice: "voice-1" } : {}), refs: ["assets/ref.png"] }));
  const makeProject = (id: string) => parseProject({ schemaVersion: 1, id, title: "测试", aspect: "16:9", knowledgeSources: [], assets, scenes: assets.map(asset => ({ id: `shot-${asset.id}`, kind: "image", src: "assets/original.png", assetRefs: [{ assetId: asset.id, version: "v1" }], narration: { text: "镜头", durationMs: 1000 } })) });
  const drafts = [makeProject("frozen-project"), makeProject("active-project")];
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }); for (const draft of drafts) store.open(draft.id, draft);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }]), submit: vi.fn(async () => "mock-task") };
  const jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client });
  const server = createWebServer({ mediaJobs: jobs, sessionStore: store, modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")), mediaSettings: createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" } }), requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, value: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    for (const draft of drafts) {
      for (const [index, kind] of ["character", "product"].entries()) {
        const response = await post(`/api/session/approve-${kind}`, { projectId: draft.id, assetId: kind, transactionId: `approve-${kind}`, baseRevision: index });
        expect(response.status).toBe(200);
        expect(parseProject((await response.json()).snapshot.document).assets![index]!.approval?.refSha256).toBe(sha256);
      }
    }
    const frozenDraft = drafts[0]!;
    expect((await post("/api/session/apply", { projectId: frozenDraft.id, transaction: { id: "freeze", projectId: frozenDraft.id, baseRevision: 2, actor: "user", scope: {}, operations: [{ kind: "set", path: ["frozen"], value: true }], intent: "freeze" } })).status).toBe(200);
    const frozen = parseProject(store.snapshot(frozenDraft.id).snapshot.document), active = parseProject(store.snapshot(drafts[1]!.id).snapshot.document);
    const endpoint = `${base}/api/media/submit`;
    const send = (project: typeof frozen, assetId: string, requestId: string, extra: Record<string, unknown> = {}) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image", model: "edit", prompt: "测试", params: {}, requestId, ...extra, reference: { projectId: project.id, sceneId: `shot-${assetId}`, assetId, basis: sceneReworkContext(project, `shot-${assetId}`).basis } }) });
    for (const assetId of ["character", "product"]) {
      const response = await send(frozen, assetId, `frozen-${assetId}`);
      expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/冻结/);
    }
    expect(client.submit).not.toHaveBeenCalled(); expect(store.snapshot(frozen.id).look.revision).toBe(3);
    // M-02b contract: the active execution still needs its explicit quote approval.
    const basis = sceneReworkContext(active, "shot-product").basis;
    const approved = await approveMediaInput(base, {
      type: "image", model: "edit", prompt: "测试", params: {}, requestId: "active-product",
      referenceImage: `approved-${sha256}.png`, referenceSha256: sha256,
      referenceBinding: { projectId: active.id, sceneId: "shot-product", assetId: "product", basis, referenceImage: `approved-${sha256}.png`, sha256 },
    });
    expect((await send(active, "product", "active-product", { bindingId: approved.bindingId, quoteId: approved.quoteId })).status).toBe(202);
    expect(client.submit).toHaveBeenCalledTimes(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);

it("never records a receipt for a failed download or trusts an existing same-name file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ref-failed-"));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), hash = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(root, "ref.png"), bytes);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }]), submit: vi.fn(async () => "task-failed"), status: vi.fn(async () => ({ task_id: "task-failed", state: "success", is_final: true, result_url: "https://asset.test/candidate.png" })) };
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download: vi.fn(async () => ({ contentType: "image/png", bytes: Buffer.from("bad") })) });
  try {
    await jobs.submit({ type: "image", model: "edit", prompt: "x", params: {}, requestId: "failed-1", referenceImage: "ref.png", referenceSha256: hash, referenceBinding: { projectId: "p", sceneId: "s", assetId: "a", basis: "basis", referenceImage: "ref.png", sha256: hash } });
    await expect(jobs.status("task-failed")).rejects.toThrow(/候选格式无效|ingest/);
    expect(JSON.parse(fs.readFileSync(path.join(root, "task-failed.json"), "utf8"))).not.toHaveProperty("candidateReceipt");
    expect(fs.existsSync(path.join(root, "task-failed.png"))).toBe(false);
    fs.writeFileSync(path.join(root, "task-failed.png"), bytes);
    await expect(jobs.status("task-failed")).rejects.toThrow(/可信下载回执/);
    expect(fs.readFileSync(path.join(root, "task-failed.png"))).toEqual(bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
