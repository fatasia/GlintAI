import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMediaJobs } from "./media-jobs.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const env = { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" };
const success = { task_id: "task-1", state: "success", is_final: true, cost: 0.5, result_url: "https://asset.test/clip.wav" };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-terminal-")); roots.push(root);
  const fixture = path.join(root, "fixture.wav");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-ar", "8000", fixture], { windowsHide: true });
  const bytes = fs.readFileSync(fixture); fs.unlinkSync(fixture);
  const client = { submit: vi.fn(async () => "task-1"), status: vi.fn(async () => success) };
  const download = vi.fn(async () => ({ contentType: "audio/wav", bytes }));
  const jobs = createMediaJobs(root, env, { client, download });
  const input = { type: "audio", model: "music", prompt: "music", params: {}, requestId: "request-1" };
  const record = () => JSON.parse(fs.readFileSync(path.join(root, "task-1.json"), "utf8"));
  return { root, client, download, jobs, input, record };
}

it.each(["running", "failed", "error"])("ignores a late %s poll after success and downloads/counts once", async state => {
  const { jobs, input, client, download, record } = setup(); await jobs.submit(input);
  let resolve!: (value: typeof success) => void, reject!: (reason: Error) => void;
  client.status.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const late = jobs.status("task-1");
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", isFinal: true });
  if (state === "error") reject(new Error("late network failure"));
  else resolve({ ...success, state, is_final: state === "failed", cost: 9 });
  expect(await late).toMatchObject({ state: "success", isFinal: true, cost: 0.5, assetUrl: "/api/media/assets/task-1.wav" });
  expect(record().state).toBe("success"); expect(download).toHaveBeenCalledOnce();
  expect(jobs.spend()).toEqual({ total: 0.5, count: 1 });
});

it("restores completed media after restart without contacting an unavailable gateway", async () => {
  const { root, jobs, input, client, download } = setup(); await jobs.submit(input); await jobs.status("task-1");
  client.status.mockRejectedValue(new Error("gateway offline"));
  const reopened = createMediaJobs(root, env, { client, download });
  const result = await reopened.status("task-1");
  expect(result).toMatchObject({ state: "success", isFinal: true, cost: 0.5, assetUrl: "/api/media/assets/task-1.wav" });
  expect(JSON.stringify(result)).not.toContain("https://asset.test");
  expect(client.status).toHaveBeenCalledOnce(); expect(download).toHaveBeenCalledOnce();
});

it("retries a failed download from its terminal receipt after restart without billing again", async () => {
  const { root, jobs, input, client, download } = setup(); await jobs.submit(input);
  download.mockRejectedValueOnce(new Error("download interrupted"));
  await expect(jobs.status("task-1")).rejects.toThrow("download interrupted");
  expect(jobs.cancel("task-1")).toBeNull();
  client.status.mockRejectedValue(new Error("gateway offline"));
  const reopened = createMediaJobs(root, env, { client, download });
  expect(await reopened.status("task-1")).toMatchObject({ state: "success", assetUrl: "/api/media/assets/task-1.wav" });
  expect(download).toHaveBeenCalledTimes(2); expect(client.status).toHaveBeenCalledOnce();
  expect(reopened.spend()).toEqual({ total: 0.5, count: 1 });
});

it("keeps the existing non-cancellable terminal stage while a download is in flight", async () => {
  const { jobs, input, download } = setup(); await jobs.submit(input);
  const data = await download(); download.mockClear();
  let finish!: (value: typeof data) => void;
  download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = jobs.status("task-1");
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(jobs.cancel("task-1")).toBeNull(); finish(data);
  expect(await pending).toMatchObject({ state: "success", assetUrl: "/api/media/assets/task-1.wav" });
});

it("keeps an older terminal state while recovering its missing receipt", async () => {
  const { root, jobs, input, client, download, record } = setup(); await jobs.submit(input);
  await jobs.status("task-1");
  const old = record(); delete old.terminalReceipt;
  fs.writeFileSync(path.join(root, "task-1.json"), JSON.stringify(old));
  client.status.mockResolvedValueOnce({ ...success, state: "failed", cost: 7 });
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", isFinal: true, assetUrl: "/api/media/assets/task-1.wav" });
  expect(record().state).toBe("success"); expect(download).toHaveBeenCalledOnce();
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", cost: 0.5 });
  expect(record().terminalReceipt).toMatchObject({ state: "success", result_url: success.result_url });
  expect(jobs.spend()).toEqual({ total: 0.5, count: 1 });
});

it("can obtain a missing success URL on a later poll without charging twice", async () => {
  const { jobs, input, client, download } = setup(); await jobs.submit(input);
  client.status.mockResolvedValueOnce({ ...success, result_url: "" });
  download.mockRejectedValueOnce(new Error("Media task is not complete"));
  await expect(jobs.status("task-1")).rejects.toThrow("Media task is not complete");
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", assetUrl: "/api/media/assets/task-1.wav" });
  expect(client.status).toHaveBeenCalledTimes(2); expect(download).toHaveBeenCalledTimes(2);
  expect(jobs.spend()).toEqual({ total: 0.5, count: 1 });
});

it("keeps a durable failure terminal without polling or downloading again", async () => {
  const { root, jobs, input, client, download } = setup(); await jobs.submit(input);
  client.status.mockResolvedValueOnce({ ...success, state: "failed" });
  expect(await jobs.status("task-1")).toMatchObject({ state: "failed", isFinal: true });
  const reopened = createMediaJobs(root, env, { client, download });
  expect(await reopened.status("task-1")).toMatchObject({ state: "failed", isFinal: true });
  expect(client.status).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
  expect(jobs.spend()).toEqual({ total: 0, count: 0 });
});

it("refreshes expired download URLs without resubmitting or changing the success receipt", async () => {
  const { jobs, input, client, download, record } = setup(); await jobs.submit(input);
  download.mockRejectedValueOnce(new Error("Source HTTP 403"));
  await expect(jobs.status("task-1")).rejects.toThrow("Source HTTP 403");
  expect(record()).toMatchObject({ state: "success", isFinal: true });
  expect(record().terminalReceipt.result_url).toBeUndefined();
  client.status.mockResolvedValueOnce({ ...success, cost: 9, result_url: "https://asset.test/renewed.wav" });
  expect(await jobs.status("task-1")).toMatchObject({ state: "success", cost: 0.5, assetUrl: "/api/media/assets/task-1.wav" });
  expect(record().terminalReceipt.result_url).toBe("https://asset.test/renewed.wav");
  expect(client.submit).toHaveBeenCalledOnce(); expect(client.status).toHaveBeenCalledTimes(2);
  expect(jobs.spend()).toEqual({ total: 0.5, count: 1 });
});
