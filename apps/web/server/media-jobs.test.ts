import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaJobs } from "./media-jobs.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-jobs-")); roots.push(root);
  const client = { submit: vi.fn(async () => "task-1"), status: vi.fn(async () => ({ task_id: "task-1", state: "success", is_final: true, result_url: "https://asset.test/audio.wav" })) };
  const download = vi.fn(async () => ({ contentType: "audio/wav", bytes: Buffer.from("fixture") }));
  const jobs = createMediaJobs(root, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download });
  const input = { type: "audio", model: "music", prompt: "Instrumental", params: {}, requestId: "request-1" };
  return { root, client, download, jobs, input };
}
it("reserves request IDs before a paid submission and reuses task and download", async () => {
  const { jobs, input, client, download } = setup();
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(await jobs.submit(input)).toEqual({ taskId: "task-1" });
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(jobs.findRequest(input.requestId)).toEqual({ taskId: "task-1" });
  await expect(jobs.submit({ ...input, prompt: "Changed" })).rejects.toThrow(/different input/);
  const result = await jobs.status("task-1"); await jobs.status("task-1");
  expect(result.assetUrl).toBe("/api/media/assets/task-1.wav"); expect(download).toHaveBeenCalledTimes(1);
  expect(jobs.library()[0].name).toBe("task-1.wav"); expect(jobs.asset("../task-1.wav")).toBeNull();
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
it("streams uploads with a hard size cap and cleans partial files", async () => {
  const { root, jobs } = setup();
  const { Readable } = await import("node:stream");
  const ok = await jobs.upload(Readable.from([Buffer.from("mp4")]), "upload-1.mp4");
  expect(ok).toEqual({ name: "upload-1.mp4", bytes: 3 });
  expect(fs.readFileSync(path.join(root, "upload-1.mp4"), "utf8")).toBe("mp4");
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