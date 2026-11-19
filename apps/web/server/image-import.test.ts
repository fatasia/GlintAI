import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it("imports decoded local images without overwrites, then binds a reference by hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-image-import-"));
  const media = path.join(root, "media"); fs.mkdirSync(media);
  const client = { models: vi.fn(async () => [{ id: "edit", tags: ["图生图"] }]), submit: vi.fn(async () => "task-1") };
  const jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client });
  const server = createWebServer({ mediaJobs: jobs, modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")), mediaSettings: createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" } }), requestLogDir: path.join(root, "logs") }) as Server;
  const fixture = (ext: string) => {
    const file = path.join(root, `fixture.${ext}`);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", "-threads", "1", file], { timeout: 30000 });
    return fs.readFileSync(file);
  };
  try {
    const png = fixture("png"), jpg = fixture("jpg"), webp = fixture("webp");
    fs.writeFileSync(path.join(media, "keep.png"), "user file");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const upload = await fetch(origin + "/api/media/import-image", { method: "POST", headers: { "content-type": "image/png" }, body: png as unknown as BodyInit });
    expect(upload.status).toBe(201);
    const imported = await upload.json();
    expect(imported.name).toMatch(/^import-[a-z0-9-]+\.png$/); expect(imported.width).toBe(32); expect(imported.height).toBe(32);
    expect(fs.readFileSync(path.join(media, imported.name))).toEqual(png);
    expect(fs.readFileSync(path.join(media, "keep.png"), "utf8")).toBe("user file");
    for (const [bytes, type, ext] of [[jpg, "image/jpeg", ".jpg"], [webp, "image/webp", ".webp"]] as const) {
      const result = await jobs.uploadImage(Readable.from([bytes]), type, new AbortController().signal);
      expect(result.name.endsWith(ext)).toBe(true); expect(fs.readFileSync(path.join(media, result.name))).toEqual(bytes);
    }
    const sha256 = createHash("sha256").update(png).digest("hex");
    // M-02b contract: the actual host only executes an explicitly quoted and approved input.
    const approved = await approveMediaInput(origin, {
      type: "image", model: "edit", prompt: "transparent", requestId: "import-test", params: {}, referenceImage: imported.name, referenceSha256: sha256,
    });
    const submit = await fetch(origin + "/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...approved, libraryReference: { name: imported.name, sha256 },
    }) });
    expect(submit.status).toBe(202); expect(client.submit).toHaveBeenCalledTimes(1);
    await expect(jobs.uploadImage(Readable.from([png]), "image/jpeg", new AbortController().signal)).rejects.toThrow(/format/i);
    await expect(jobs.uploadImage(Readable.from([png.subarray(0, 20)]), "image/png", new AbortController().signal)).rejects.toThrow();
    await expect(jobs.uploadImage(Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)]), "image/png", new AbortController().signal)).rejects.toThrow(/8 MiB/);
    expect(fs.readdirSync(media).some(name => name.startsWith(".incoming-image-"))).toBe(false);
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
