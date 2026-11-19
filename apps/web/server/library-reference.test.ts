import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("accepts only a content-bound library image and submits it once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-library-ref-"));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(root, "test.png"), bytes);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["Image-to-image"] }]), submit: vi.fn(async () => "job-1") };
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client });
  const server = createWebServer({ mediaJobs: jobs, modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")), mediaSettings: createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" } }), requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${base}/api/media/submit`;
    const body = { type: "image", model: "edit", prompt: "transparent", requestId: "lib-ref-1", params: { background: "transparent" }, libraryReference: { name: "test.png", sha256 } };
    const send = (value: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    // M-02b contract: the actual host only executes an explicitly quoted and approved input.
    const approved = await approveMediaInput(base, { type: "image", model: "edit", prompt: "transparent", requestId: "lib-ref-1", params: { background: "transparent" }, referenceImage: "test.png", referenceSha256: sha256 });
    expect((await send({ ...approved, libraryReference: { name: "test.png", sha256 } })).status).toBe(202);
    expect((await send({ ...approved, libraryReference: { name: "test.png", sha256 } })).status).toBe(202);
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect((client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2].images).toEqual([`data:image/png;base64,${bytes.toString("base64")}`]);
    expect((await send({ ...body, requestId: "wrong-hash", libraryReference: { name: "test.png", sha256: "0".repeat(64) } })).status).toBe(400);
    expect((await send({ ...body, requestId: "wrong-path", libraryReference: { name: "../test.png", sha256 } })).status).toBe(400);
    expect((await send({ ...body, requestId: "mixed", canvasReference: { taskId: "x", sha256 } })).status).toBe(400);
    expect(client.submit).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
