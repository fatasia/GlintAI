import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMediaJobs } from "./media-jobs.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** Real decodable media: the ingest gate refuses bytes ffprobe cannot read. */
const fixtures = new Map<string, Buffer>();
function mediaFixture(kind: "wav" | "mp4" | "png"): Buffer {
  const cached = fixtures.get(kind);
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-fixture-"));
  const file = path.join(dir, `fixture.${kind}`);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y",
    ...(kind === "wav" ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-ar", "8000"]
      : kind === "png" ? ["-f", "lavfi", "-i", "color=c=red:size=32x32", "-frames:v", "1"]
      : ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=0.3", "-pix_fmt", "yuv420p"]),
    file], { timeout: 60_000 });
  const bytes = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  fixtures.set(kind, bytes);
  return bytes;
}

function setup(download?: (task: unknown, signal: AbortSignal) => Promise<{ contentType: string; bytes: Buffer }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-jobs-")); roots.push(root);
  const client = { submit: vi.fn(async () => "task-1"), status: vi.fn(async () => ({ task_id: "task-1", state: "success", is_final: true, result_url: "https://asset.test/audio.wav" })) };
  const downloadImpl = download ?? vi.fn(async () => ({ contentType: "audio/wav", bytes: Buffer.from("fixture") }));
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download: downloadImpl });
  const input = { type: "audio", model: "music", prompt: "Instrumental", params: {}, requestId: "request-1" };
  return { root, client, download: downloadImpl, jobs, input };
}
it("reserves request IDs before a paid submission and reuses task and download", async () => {
  const { jobs, input, client, download } = setup(vi.fn(async () => ({ contentType: "audio/wav", bytes: mediaFixture("wav") })));
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(jobs.findRequest(input.requestId)).toEqual({ taskId: "task-1" });
  await expect(jobs.submit({ ...input, prompt: "Changed" })).rejects.toThrow(/different input/);
  const result = await jobs.status("task-1"); await jobs.status("task-1");
  expect(result.assetUrl).toBe("/api/media/assets/task-1.wav"); expect(download).toHaveBeenCalledTimes(1);
  expect(jobs.library()[0].name).toBe("task-1.wav"); expect(jobs.asset("../task-1.wav")).toBeNull();
});
it("refuses a broken generated result at ingest and keeps it out of the library", async () => {
  const { root, jobs, input } = setup();
  await jobs.submit(input);
  await expect(jobs.status("task-1")).rejects.toThrow(/ingest check/);
  expect(fs.existsSync(path.join(root, "task-1.wav"))).toBe(false);
  expect(jobs.library()).toEqual([]);
});
it("accumulates a local spend ledger and blocks new paid submissions past the budget cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-budget-")); roots.push(root);
  const client = { submit: vi.fn(async () => "task-budget"), status: vi.fn(async () => ({ task_id: "task-budget", state: "success", is_final: true, cost: 0.6, result_url: "https://asset.test/a.wav" })) };
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test", GLINT_MEDIA_BUDGET: "0.5" }, { client, download: vi.fn(async () => ({ contentType: "audio/wav", bytes: mediaFixture("wav") })) });
  const input = { type: "audio", model: "music", prompt: "配乐", params: {}, requestId: "budget-1" };
  expect((await jobs.submit(input)).taskId).toBe("task-budget");
  const first = await jobs.status("task-budget");
  expect(first.cost).toBe(0.6);
  expect(jobs.spend()).toEqual({ total: 0.6, count: 1 });
  // Re-polling the final task must not double-count its cost.
  await jobs.status("task-budget");
  expect(jobs.spend()).toEqual({ total: 0.6, count: 1 });
  // A second requestId has real money behind it and must be refused by the cap.
  await expect(jobs.submit({ ...input, requestId: "budget-2" })).rejects.toThrow(/预算已用尽/);
  expect(client.submit).toHaveBeenCalledTimes(1);
});
it("does not retry an uncertain submission after a lost response", async () => {
  const { jobs, input, client } = setup(); client.submit.mockRejectedValue(new Error("lost response"));
  await expect(jobs.submit(input)).rejects.toThrow();
  await expect(jobs.submit(input)).rejects.toThrow(/uncertain/);
  expect(client.submit).toHaveBeenCalledTimes(1);
  await expect(jobs.status("unknown")).rejects.toThrow(/Unknown/);
});

it("lists only regular library files and denies missing, directory and symlink assets", () => {
  const { root, jobs } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-outside-")); roots.push(outside);
  fs.writeFileSync(path.join(root, "clip.mp4"), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(root, "image.png"), "image bytes");
  fs.writeFileSync(path.join(outside, "secret.mp4"), "private bytes");
  fs.mkdirSync(path.join(root, "directory.mp4"));
  // Windows junctions exercise real symlink rejection without requiring SeCreateSymbolicLinkPrivilege.
  const windows = process.platform === "win32", type = windows ? "junction" : "file";
  fs.symlinkSync(windows ? outside : path.join(outside, "secret.mp4"), path.join(root, "outside.mp4"), type);
  fs.symlinkSync(windows ? path.join(root, "directory.mp4") : path.join(root, "clip.mp4"), path.join(root, "inside.mp4"), type);
  fs.symlinkSync(path.join(outside, "absent.mp4"), path.join(root, "broken.mp4"), type);
  expect(jobs.library().map(asset => asset.name).sort()).toEqual(["clip.mp4", "image.png"]);
  expect(jobs.asset("clip.mp4")).toBe(path.join(root, "clip.mp4"));
  for (const name of ["missing.mp4", "directory.mp4", "outside.mp4", "inside.mp4", "broken.mp4", "../secret.mp4", "clip.mp4\n", "clip.mp4?x"]) expect(jobs.asset(name), name).toBeNull();
});
it("denies assets when the library root is redirected outside its real root", () => {
  const { root } = setup();
  const redirected = path.join(root, "redirected"), target = path.join(root, "target");
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, "clip.mp4"), "private bytes");
  fs.mkdirSync(redirected);
  const jobs = createMediaJobs(redirected, {});
  fs.rmdirSync(redirected); fs.symlinkSync(target, redirected, process.platform === "win32" ? "junction" : "dir");
  expect(jobs.asset("clip.mp4")).toBeNull(); expect(jobs.library()).toEqual([]);
});
it("reads the image edit chain and rejects unsafe entries", () => {
  const { root, jobs } = setup();
  fs.writeFileSync(path.join(root, "versions.json"), JSON.stringify([
    { file: "a.png", parent: null, model: "doubao", prompt: "换背景", cost: 0.1, at: new Date().toISOString() },
    { file: "../evil.png", parent: null },
    { file: "b.png", parent: "../x.png", model: 7, prompt: "精修" },
  ]));
  const versions = jobs.versions();
  expect(versions.map(version => version.file)).toEqual(["a.png", "b.png"]);
  expect(versions[0]).toMatchObject({ model: "doubao", prompt: "换背景", cost: 0.1 });
  expect(versions[1]).toMatchObject({ parent: null, model: "", prompt: "精修" });
});
it("installs a reference frame under a fresh library name and never overwrites", () => {
  const { root, jobs } = setup();
  const source = path.join(root, "staged.jpg");
  fs.writeFileSync(source, "reference bytes");
  expect(jobs.install(source, "ref-abc-001.jpg")).toBe("ref-abc-001.jpg");
  expect(fs.readFileSync(path.join(root, "ref-abc-001.jpg"), "utf8")).toBe("reference bytes");
  expect(() => jobs.install(source, "ref-abc-001.jpg")).toThrow(/already exists/);
  for (const bad of ["../x.jpg", "x.gif", "x.mp4\\", ""]) expect(() => jobs.install(source, bad as string)).toThrow();
});
it("streams uploads with a hard size cap, decodability gate and cleans partial files", async () => {
  const { root, jobs } = setup();
  const { Readable } = await import("node:stream");
  const mp4 = mediaFixture("mp4");
  const ok = await jobs.upload(Readable.from([mp4]), "upload-1.mp4");
  expect(ok).toEqual({ name: "upload-1.mp4", bytes: mp4.length });
  expect(fs.readFileSync(path.join(root, "upload-1.mp4"))).toEqual(mp4);
  await expect(jobs.upload(Readable.from([Buffer.from("not a video")]), "junk.mp4")).rejects.toThrow(/decodable/);
  expect(fs.existsSync(path.join(root, "junk.mp4"))).toBe(false);
  await expect(jobs.upload(Readable.from([Buffer.alloc(64)]), "too-big.mp4", 16)).rejects.toThrow(/too large/);
  expect(fs.existsSync(path.join(root, "too-big.mp4"))).toBe(false);
  expect(fs.readdirSync(root).some(file => file.startsWith(".incoming-"))).toBe(false);
});
function openaiSetup(fetchImpl: (url: string) => Promise<Response>, download = vi.fn(async () => ({ contentType: "image/png", bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]) }))) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-openai-")); roots.push(root);
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test/v1/", GLINT_MEDIA_API_KEY: "sk-test-12345678", GLINT_MEDIA_PROTOCOL: "openai-images" }, { fetchImpl, download });
  const input = { type: "image", model: "gpt-image-2", prompt: "一只橘猫", params: { size: "1024x1024" }, requestId: "request-openai-1" };
  return { root, jobs, download, input };
}
it("generates and downloads an image through the OpenAI Images protocol once", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ url: "https://cdn.test/image.png" }] }));
  const { root, jobs, download, input } = openaiSetup(fetchImpl);
  expect(jobs.protocol()).toBe("openai-images");
  const { taskId } = await jobs.submit(input);
  expect(fetchImpl.mock.calls[0][0]).toBe("https://gateway.test/v1/images/generations");
  const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toMatchObject({ model: "gpt-image-2", n: 1, size: "1024x1024" });
  const status = await jobs.status(taskId);
  expect(status).toMatchObject({ taskId, state: "success", isFinal: true, assetUrl: `/api/media/assets/${taskId}.png` });
  expect(download).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(root, `${taskId}.png`))).toBe(true);
  expect((await jobs.status(taskId)).assetUrl).toBe(status.assetUrl);
  expect(download).toHaveBeenCalledTimes(1);
  jobs.applyEnv({ GLINT_MEDIA_PROTOCOL: "skills" });
  expect((await jobs.status(taskId)).assetUrl).toBe(status.assetUrl);
});
it("retries a CDN download blocked by fake-IP DNS through public DNS", async () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ url: "https://cdn.test/image.png" }] }));
  const download = vi.fn()
    .mockRejectedValueOnce(new Error("Private, loopback or reserved source URL is not allowed"))
    .mockResolvedValueOnce({ contentType: "image/png", bytes });
  const { jobs, input } = openaiSetup(fetchImpl, download);
  const { taskId } = await jobs.submit(input);
  expect((await jobs.status(taskId)).assetUrl).toBe(`/api/media/assets/${taskId}.png`);
  expect(download).toHaveBeenCalledTimes(2);
  expect(download.mock.calls[0]![2]).toEqual({ publicDns: false });
  expect(download.mock.calls[1]![2]).toEqual({ publicDns: true });
});
it("does not retry unrelated download failures", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ url: "https://cdn.test/image.png" }] }));
  const download = vi.fn(async () => { throw new Error("Source HTTP 500"); });
  const { jobs, input } = openaiSetup(fetchImpl, download);
  const { taskId } = await jobs.submit(input);
  await expect(jobs.status(taskId)).rejects.toThrow(/HTTP 500/);
  expect(download).toHaveBeenCalledTimes(1);
});
it("accepts a base64 image payload without a download round trip", async () => {  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128)]);
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ b64_json: bytes.toString("base64") }] }));
  const { jobs, download, input } = openaiSetup(fetchImpl);
  const { taskId } = await jobs.submit(input);
  expect((await jobs.status(taskId)).assetUrl).toBe(`/api/media/assets/${taskId}.png`);
  expect(download).not.toHaveBeenCalled();
});
it("rejects video before reserving a receipt and releases the receipt after a 4xx rejection", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { message: "model not found" } }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.test/retry.png" }] }));
  const { jobs, input } = openaiSetup(fetchImpl as unknown as (url: string) => Promise<Response>);
  await expect(jobs.submit({ ...input, type: "video" })).rejects.toThrow(/only generates images/);
  expect(jobs.findRequest(input.requestId)).toBeNull();
  await expect(jobs.submit(input)).rejects.toThrow(/model not found/);
  expect(jobs.findRequest(input.requestId)).toBeNull();
  const retry = await jobs.submit(input);
  expect(retry.taskId).toBeTruthy();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("keeps the receipt for an ambiguous 408 timeout", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ error: { message: "gateway timeout" } }, { status: 408 }));
  const { jobs, input } = openaiSetup(fetchImpl);
  await expect(jobs.submit(input)).rejects.toThrow(/gateway timeout/);
  await expect(jobs.submit(input)).rejects.toThrow(/uncertain/);
});
it("lists only plausible image models for the OpenAI Images protocol", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: "deepseek-v4.1-flash" }, { id: "gpt-image-2" }, { id: "dall-e-3" }] }));
  const { jobs } = openaiSetup(fetchImpl);
  expect((await jobs.models("image")).map(model => model.id)).toEqual(["gpt-image-2", "dall-e-3"]);
  expect(await jobs.models("video")).toEqual([]);
});
it("does not relabel chat models as image models when nothing matches", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: "tt-4o" }, { id: "gem-3.8-flash" }] }));
  const { jobs } = openaiSetup(fetchImpl);
  expect(await jobs.models("image")).toEqual([]);
});

/** GEN-01: the gateway has no cancel endpoint, so cancellation is client-side —
 * detach the task without gateway traffic, downloads or spend, and without
 * letting a reused requestId trigger a second paid submission. */
it("cancels a queued task client-side: polling detaches, nothing is downloaded or re-billed", async () => {
  const { jobs, client, download, input } = setup();
  client.status.mockResolvedValue({ task_id: "task-1", state: "pending", is_final: false });
  await jobs.submit(input);
  expect(await jobs.status("task-1")).toMatchObject({ state: "pending", isFinal: false });
  expect(jobs.spend()).toEqual({ total: 0, count: 0 });
  const cancelled = jobs.cancel("task-1");
  expect(cancelled).toMatchObject({ taskId: "task-1", state: "cancelled", isFinal: true });
  expect(jobs.cancel("task-1")).toMatchObject({ state: "cancelled", isFinal: true });
  expect(await jobs.status("task-1")).toMatchObject({ state: "cancelled", isFinal: true });
  expect(client.status).toHaveBeenCalledTimes(1);
  expect(download).not.toHaveBeenCalled();
  // The detached requestId resolves to the same task: no second paid submission.
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(jobs.cancel("missing-task")).toBeNull();
});

it("refuses to cancel a finished task, and cancellation survives a restart without spend", async () => {
  const { root, jobs, client, input } = setup(vi.fn(async () => ({ contentType: "audio/wav", bytes: mediaFixture("wav") })));
  client.status.mockResolvedValue({ task_id: "task-1", state: "success", is_final: true, cost: 0.4, result_url: "https://asset.test/a.wav" });
  await jobs.submit(input);
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", isFinal: true });
  expect(jobs.spend()).toEqual({ total: 0.4, count: 1 });
  expect(jobs.cancel("task-1")).toBeNull();
  // Reopen the store on the same root: finality and cancellation are durable.
  const reopened = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download: vi.fn() });
  expect(reopened.cancel("task-1")).toBeNull();
  client.status.mockResolvedValue({ task_id: "task-1", state: "pending", is_final: false });
  await jobs.submit({ ...input, requestId: "request-2" });
  jobs.cancel("task-1");
  const statusCalls = client.status.mock.calls.length;
  expect(await reopened.status("task-1")).toMatchObject({ state: "cancelled", isFinal: true });
  expect(client.status).toHaveBeenCalledTimes(statusCalls);
  expect(jobs.spend()).toEqual({ total: 0.4, count: 1 });
});

it.each([true, false])("keeps cancellation when an in-flight poll returns late (final=%s)", async final => {
  const { root, jobs, client, download, input } = setup();
  await jobs.submit(input);
  let finish!: (value: Awaited<ReturnType<typeof client.status>> & { cost?: number }) => void;
  client.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const polling = jobs.status("task-1");
  expect(client.status).toHaveBeenCalledOnce();
  expect(jobs.cancel("task-1")).toMatchObject({ state: "cancelled", isFinal: true });
  finish({ task_id: "task-1", state: final ? "success" : "running", is_final: final, cost: 0.25, result_url: "https://asset.test/a.wav" });
  expect(await polling).toMatchObject({ state: "cancelled", isFinal: true });
  expect(download).not.toHaveBeenCalled(); expect(jobs.spend()).toEqual({ total: 0, count: 0 });
  const stored = JSON.parse(fs.readFileSync(path.join(root, "task-1.json"), "utf8"));
  expect(stored.cancelled).toBe(true); expect(stored.state).not.toBe("success");
  const reopened = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download });
  expect(await reopened.status("task-1")).toMatchObject({ state: "cancelled", isFinal: true });
  expect(client.status).toHaveBeenCalledOnce(); expect(reopened.library()).toEqual([]);
});

it("recovers an existing request after restart even when the spend budget is exhausted", async () => {
  const { root, jobs, client, input } = setup(); await jobs.submit(input);
  fs.writeFileSync(path.join(root, "spend.json"), JSON.stringify({ total: 1, count: 1 }));
  const reopened = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test", GLINT_MEDIA_BUDGET: "1" }, { client });
  expect(await reopened.submit(input)).toEqual({ taskId: "task-1" });
  await expect(reopened.submit({ ...input, requestId: "new-request" })).rejects.toThrow(/预算已用尽/);
  await expect(reopened.submit({ ...input, prompt: "changed" })).rejects.toThrow(/different input/);
  expect(client.submit).toHaveBeenCalledOnce(); expect(reopened.spend()).toEqual({ total: 1, count: 1 });
});

/** GEN-15 task-level chain: stream upload → library retrieval → source
 * annotation (request receipt, task record, versions.json provenance) →
 * version chain read-back. Every byte in the library is locally decodable. */
it("GEN-15: upload, retrieval, source annotation and the version chain read back as one story", async () => {
  const { Readable } = await import("node:stream");
  const { root, jobs, client, download, input } = setup(vi.fn(async () => ({ contentType: "image/png", bytes: mediaFixture("png") })));
  // 1. Streamed upload lands in the library and is retrievable.
  const uploaded = await jobs.upload(Readable.from([mediaFixture("mp4")]), "upload-ref-1.mp4");
  expect(uploaded).toEqual({ name: "upload-ref-1.mp4", bytes: mediaFixture("mp4").length });
  expect(jobs.library().map(asset => asset.name)).toContain("upload-ref-1.mp4");
  expect(jobs.asset("upload-ref-1.mp4")).toBe(path.join(root, "upload-ref-1.mp4"));
  // 2. A generated image enters the same library with a full source trail:
  //    requestId → taskId receipt, plus the task record (type/model/protocol).
  await jobs.submit({ ...input, type: "image", model: "doubao-image", prompt: "生成封面", requestId: "gen-request-1" });
  expect(jobs.findRequest("gen-request-1")).toEqual({ taskId: "task-1" });
  expect(await jobs.status("task-1")).toMatchObject({ assetUrl: "/api/media/assets/task-1.png" });
  expect(download).toHaveBeenCalledTimes(1);
  const taskRecord = JSON.parse(fs.readFileSync(path.join(root, "task-1.json"), "utf8"));
  expect(taskRecord).toMatchObject({ type: "image", model: "doubao-image", protocol: "skills" });
  expect(jobs.library().map(asset => asset.name)).toContain("task-1.png");
  // 3. The edit chain (as `glint image-edit` writes versions.json): one edit on
  //    top of the generated cover, installed through the library gate.
  const staged = path.join(root, "staged-edit.png");
  fs.writeFileSync(staged, mediaFixture("png"));
  jobs.install(staged, "edit-001.png");
  fs.writeFileSync(path.join(root, "versions.json"), JSON.stringify([
    { file: "task-1.png", parent: null, model: "doubao-image", prompt: "生成封面", cost: 0.05, at: "2026-10-25T10:00:00.000Z" },
    { file: "edit-001.png", parent: "task-1.png", model: "doubao-image", prompt: "换成夜景", cost: 0.03, at: "2026-10-25T10:05:00.000Z" },
    { file: "../escape.png", parent: "edit-001.png", model: "x", prompt: "逃逸路径必须被滤掉" },
  ]));
  // 4. Read-back: order, parent links, annotations and library agreement.
  const chain = jobs.versions();
  expect(chain.map(version => version.file)).toEqual(["task-1.png", "edit-001.png"]);
  expect(chain[0]).toMatchObject({ parent: null, model: "doubao-image", prompt: "生成封面", cost: 0.05, url: "/api/media/assets/task-1.png" });
  expect(chain[1]).toMatchObject({ parent: "task-1.png", prompt: "换成夜景", cost: 0.03 });
  const names = new Set(jobs.library().map(asset => asset.name));
  for (const version of chain) expect(names.has(version.file), version.file).toBe(true);
  expect(names.has("upload-ref-1.mp4")).toBe(true);
});
it("sends one bounded local reference only for a catalog-declared skills edit model and retains idempotency", async () => {
  const { root, jobs, client } = setup();
  const models = vi.fn(async () => [{ id: "edit", tags: ["图生图"] }, { id: "plain", tags: [] }]);
  Object.assign(client, { models });
  const bytes = mediaFixture("png"); fs.writeFileSync(path.join(root, "hero.png"), bytes);
  const input = { type: "image", model: "edit", prompt: "小雨", params: {}, referenceImage: "hero.png", referenceSha256: createHash("sha256").update(bytes).digest("hex"), requestId: "ref-1" };
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(client.submit).toHaveBeenCalledTimes(1);
  const params = (client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2];
  expect(params.images).toEqual([`data:image/png;base64,${bytes.toString("base64")}`]);
  const journal = fs.readFileSync(path.join(root, "request-ref-1.json"), "utf8");
  expect(journal).not.toContain(bytes.toString("base64"));
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(client.submit).toHaveBeenCalledTimes(1);
  await expect(jobs.submit({ ...input, requestId: "ref-2", model: "plain" })).rejects.toThrow(/未声明支持/);
  await expect(jobs.submit({ ...input, requestId: "ref-injected", params: { images: ["https://example.test/injected.png"] } })).rejects.toThrow(/does not support/);
  for (const bad of ["../hero.png", "https://example.test/a.png", "missing.png"]) await expect(jobs.submit({ ...input, requestId: "ref-bad", referenceImage: bad })).rejects.toThrow();
  fs.writeFileSync(path.join(root, "large.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(jobs.submit({ ...input, requestId: "ref-large", referenceImage: "large.png" })).rejects.toThrow(/8 MiB/);
  fs.writeFileSync(path.join(root, "bad.png"), "not an image");
  await expect(jobs.submit({ ...input, requestId: "ref-invalid", referenceImage: "bad.png" })).rejects.toThrow(/格式/);
  fs.writeFileSync(path.join(root, "empty.png"), "");
  await expect(jobs.submit({ ...input, requestId: "ref-empty", referenceImage: "empty.png" })).rejects.toThrow();
  const changed = Buffer.concat([bytes, Buffer.from([0])]); fs.writeFileSync(path.join(root, "hero.png"), changed);
  await expect(jobs.submit(input)).rejects.toThrow(/内容已变化/);
  await expect(jobs.submit({ ...input, referenceSha256: createHash("sha256").update(changed).digest("hex") })).rejects.toThrow(/different input/);
  expect(client.submit).toHaveBeenCalledTimes(1);
});

it("does not submit references through the OpenAI generations protocol", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ url: "https://cdn.test/image.png" }] }));
  const { jobs, input } = openaiSetup(fetchImpl);
  await expect(jobs.submit({ ...input, referenceImage: "hero.png" })).rejects.toThrow(/does not support/);
  expect(fetchImpl).not.toHaveBeenCalled();
});


it("retains generic model image parameters without claiming approved-reference semantics", async () => {
  const { jobs, client } = setup();
  const images = ["https://example.test/existing-image.png"];
  await jobs.submit({ type: "video", model: "video-model", prompt: "镜头", params: { images }, requestId: "generic-image" });
  expect((client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2].images).toEqual(images);
});

it("never overwrites a concurrent arrival while an upload is streaming", async()=>{
  const { Readable } = await import("node:stream");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-upload-race-"));roots.push(root);
  const jobs=createMediaJobs(root,{}), existing=Buffer.from("concurrent original");
  const source=Readable.from((async function*(){
    fs.writeFileSync(path.join(root,"race.mp4"),existing,{flag:"wx"});
    yield mediaFixture("mp4");
  })());
  await expect(jobs.upload(source,"race.mp4")).rejects.toThrow();
  expect(fs.readFileSync(path.join(root,"race.mp4"))).toEqual(existing);
  expect(fs.existsSync(path.join(root,".incoming-race.mp4"))).toBe(false);
});
it("projects catalog metadata and refuses malformed reference tags before sending or reserving", async () => {
  const { root, jobs, client } = setup();
  const models = vi.fn(async () => [{ id: "edit", name: "Edit", tags: ["图生图", {}] }]);
  Object.assign(client, { models });
  const catalog = await jobs.models("image");
  expect(catalog[0]).toMatchObject({ id: "edit", registry: { capabilities: [], pricing: { basis: "unknown" }, adapter: { model: "edit", type: "skills-gateway" } } });
  const input = { type: "image", model: "edit", prompt: "fixture", params: {}, referenceImage: "hero.png", referenceSha256: "a".repeat(64), requestId: "malformed-tags" };
  await expect(jobs.submit(input)).rejects.toThrow(/未声明/);
  expect(client.submit).not.toHaveBeenCalled(); expect(jobs.findRequest(input.requestId)).toBeNull();
  expect(fs.readdirSync(root).some(name => name.startsWith("request-"))).toBe(false);
});
