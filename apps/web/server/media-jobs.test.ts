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
