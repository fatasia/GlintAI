import fs from "node:fs";
import { createHash } from "node:crypto";
import { canonicalJson } from "@glintai/session";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { sceneReworkContext } from "../src/scene-rework";
// @ts-expect-error JS server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("resolves only the durable approved shot identity rather than a client-supplied file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ref-submit-"));
  const media = path.join(root, "media"); fs.mkdirSync(media);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(media, "hero.png"), image);
  const hash = createHash("sha256").update(image).digest("hex"), pinned = `approved-${hash}.png`;
  const identity = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-1", refs: ["assets/hero.png"] };
  const draft = parseProject({ schemaVersion: 1, id: "ref-project", title: "测试", aspect: "16:9", knowledgeSources: [], assets: [identity], scenes: [{ id: "one", kind: "image", src: "assets/hero.png", assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: "镜头", durationMs: 1000 } }] });
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }); store.open(draft.id, draft);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }]), submit: vi.fn(async () => "task-ref") };
  const mediaJobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client });
  const server = createWebServer({ mediaJobs, sessionStore: store, modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")), mediaSettings: createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" } }), requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const approval = await fetch(`${base}/api/session/approve-character`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: draft.id, assetId: "hero", transactionId: "approve-fixture", baseRevision: 0 }) });
    expect(approval.status).toBe(200);
    const project = parseProject((await approval.json()).snapshot.document);
    expect(project.assets![0]!.approval?.refSha256).toBe(hash);
    const url = `${base}/api/media/submit`;
    const basis = sceneReworkContext(project, "one").basis;
    const input = { type: "image", model: "edit", prompt: "小雨", params: {}, requestId: "http-ref-1", referenceImage: "../../secret.png", reference: { projectId: project.id, sceneId: "one", assetId: "hero", basis } };
    const send = (value: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    // M-02b contract: every execution needs an explicit quote approval; the quote is
    // taken against the server-resolved reference (the durable pinned copy), which is
    // what the route derives before the guard runs.
    const binding = { projectId: project.id, sceneId: "one", assetId: "hero", basis, referenceImage: pinned, sha256: hash };
    const reference = { type: "image", model: "edit", prompt: "小雨", params: {}, referenceImage: pinned, referenceSha256: hash, referenceBinding: binding };
    const approvedRef = await approveMediaInput(base, { ...reference, requestId: "http-ref-1" });
    const approvedChanged = await approveMediaInput(base, { ...reference, requestId: "changed-file" });
    const ok = await send({ ...input, ...approvedRef }); expect(ok.status).toBe(202);
    expect((client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2].images).toEqual([`data:image/png;base64,${image.toString("base64")}`]);
    const repeat = await send({ ...input, ...approvedRef }); expect(repeat.status).toBe(202); expect(client.submit).toHaveBeenCalledTimes(1);
    for (const stale of [{ ...input.reference, basis: "stale" }, { ...input.reference, assetId: "other" }, { ...input.reference, sceneId: "other" }, { ...input.reference, projectId: "other" }]) {
      expect((await send({ ...input, requestId: "invalid-ref", reference: stale })).status).toBe(400);
    }
    const approvedDirect = await approveMediaInput(base, { type: "image", model: "edit", prompt: "小雨", params: {}, requestId: "direct-path" });
    const direct = await send({ ...input, ...approvedDirect, requestId: "direct-path", reference: undefined });
    expect(direct.status).toBe(202);
    expect((client.submit.mock.calls[1] as unknown as [string, string, Record<string, unknown>])[2]).toEqual({});
    expect(client.submit).toHaveBeenCalledTimes(2);
    fs.writeFileSync(path.join(media, pinned), Buffer.concat([image, Buffer.from([0])]));
    expect((await send({ ...input, ...approvedChanged, requestId: "changed-file" })).status).toBe(400);
    expect(client.submit).toHaveBeenCalledTimes(2);
    const legacy = parseProject({ ...project, id: "legacy-project", assets: [{ ...identity, refs: ["assets/hero.png"], approval: { version: identity.version, name: identity.name, description: identity.description, voice: identity.voice, refs: ["assets/hero.png"] } }] });
    // Legacy persisted journals predate content-pinned approvals; test read compatibility without importing one.
    const state = { projectId: legacy.id, revision: 0, document: legacy, history: [], selection: [] };
    const legacyFile = path.join(root, "sessions", `${createHash("sha256").update(legacy.id).digest("hex")}.json`);
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, checksum: createHash("sha256").update(canonicalJson(state)).digest("hex"), state }));
    expect((await send({ ...input, requestId: "legacy-request", reference: { ...input.reference, projectId: legacy.id, basis: sceneReworkContext(legacy, "one").basis } })).status).toBe(400);
    expect(client.submit).toHaveBeenCalledTimes(2);
    await new Promise(resolve => setTimeout(resolve, 100));
    const logFile = path.join(root, "logs", "requests.log");
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(image.toString("base64"));
    expect(fs.readFileSync(logFile, "utf8")).not.toContain("gateway.test");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
