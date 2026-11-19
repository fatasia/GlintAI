import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
// @ts-expect-error JS server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("sends only a verified completed task image to a reference-capable model, once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-canvas-ref-"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const hash = createHash("sha256").update(image).digest("hex");
  fs.writeFileSync(path.join(root, "source.png"), image);
  fs.writeFileSync(path.join(root, "source.json"), JSON.stringify({ type: "image", state: "success", isFinal: true }));
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }, { id: "plain", tags: [] }]), submit: vi.fn(async () => "output") };
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client });
  const server = createWebServer({ mediaJobs: jobs, modelRegistryStore: createModelRegistryStore(path.join(root,"registry.json")), mediaSettings: createMediaSettings({env:{GLINT_MEDIA_BASE_URL:"https://gateway.test",GLINT_MEDIA_API_KEY:"test"}}), requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/media/submit`;
    const baseInput = { type: "image", model: "edit", prompt: "夜景", params: {}, requestId: "canvas-1", canvasReference: { taskId: "source", sha256: hash } };
    const input = await approveMediaInput(url.replace("/api/media/submit",""), baseInput);
    const send = (value: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    expect((await send(input)).status).toBe(202);
    expect((client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2].images).toEqual([`data:image/png;base64,${image.toString("base64")}`]);
    expect((await send(input)).status).toBe(202); expect(client.submit).toHaveBeenCalledTimes(1);
    for (const bad of [
      { ...input, requestId: "bad-model", model: "plain" },
      { ...input, requestId: "bad-hash", canvasReference: { taskId: "source", sha256: "0".repeat(64) } },
      { ...input, requestId: "bad-path", canvasReference: { taskId: "../source", sha256: hash } },
      { ...input, requestId: "bad-type", type: "video" },
      { ...input, requestId: "bad-params", params: { images: ["https://example.test/image.png"] } },
    ]) expect((await send(bad)).status).toBe(400);
    fs.writeFileSync(path.join(root, "source.png"), Buffer.concat([image, Buffer.from([0])]));
    expect((await send({ ...input, requestId: "changed" })).status).toBe(400);
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, "request-canvas-1.json"), "utf8")).not.toContain(image.toString("base64"));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
