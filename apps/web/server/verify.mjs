import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWebServer } from "./index.mjs";
import { createJobRunner } from "./jobs.mjs";
const studioDir = fileURLToPath(new URL("../../studio", import.meta.url));
const output = fs.mkdtempSync(path.join(os.tmpdir(), "glint-web-check-"));
const runner = createJobRunner({ studioDir, env: { ...process.env, GLINT_LLM_API_KEY: "" } });
const server = createWebServer({ makeRunner: runner });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { status: "running", output, started: new Date().toISOString() };
try {
  const payload = { source: "# 理解从问题开始\n\n## 提问\n先提出一个问题。", template: "explainer", theme: "cream-editorial", requestId: randomUUID() };
  const submit = async (body = payload) => {
    const response = await fetch(`${origin}/api/make`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const { jobId } = await submit(); report.jobId = jobId;
  assert.equal((await submit()).jobId, jobId, "Retries must not create duplicate jobs");
  const recoveredRequest=await (await fetch(`${origin}/api/make/request/${payload.requestId}`)).json();
  assert.equal(recoveredRequest.id,jobId,"Lost POST response must be recoverable by its persisted requestId");
  const queued = await submit({ ...payload, requestId: randomUUID() });
  assert.equal((await (await fetch(`${origin}/api/make/${queued.jobId}`)).json()).status, "queued");
  assert.equal((await fetch(`${origin}/api/make/${queued.jobId}`, { method: "DELETE" })).status, 200);
  assert.equal((await (await fetch(`${origin}/api/make/${queued.jobId}`)).json()).status, "cancelled");
  const deadline = Date.now() + 240_000;
  let job;
  do {
    job = await (await fetch(`${origin}/api/make/${jobId}`)).json();
    if (["done", "failed", "cancelled"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } while (Date.now() < deadline);
  assert.equal(job.status, "done", JSON.stringify(job));
  const runningJob = await submit({ ...payload, requestId: randomUUID() });
  assert.equal((await fetch(`${origin}/api/make/${runningJob.jobId}`, { method: "DELETE" })).status, 200);
  const cancelDeadline = Date.now() + 15_000;
  let cancelled;
  do {
    cancelled = await (await fetch(`${origin}/api/make/${runningJob.jobId}`)).json();
    if (cancelled.status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < cancelDeadline);
  assert.equal(cancelled.status, "cancelled", "Running process tree must stop");
  const full = await fetch(`${origin}${job.video}`), bytes = Buffer.from(await full.arrayBuffer());
  assert(bytes.length > 1000); assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
  const destination = path.join(output, "offline-draft.mp4"); fs.writeFileSync(destination, bytes);
  const range = await fetch(`${origin}${job.video}`, { headers: { range: "bytes=0-31" } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 32));
  const suffix = await fetch(`${origin}${job.video}`, { headers: { range: "bytes=-16" } });
  assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-16));
  assert.equal((await fetch(`${origin}${job.video}`, { headers: { range: `bytes=${bytes.length}-` } })).status, 416);
  const download = await fetch(`${origin}${job.video}?download=1`, { method: "HEAD" });
  assert.match(download.headers.get("content-disposition"), /attachment/); assert.equal(Number(download.headers.get("content-length")), bytes.length);
  const recovered = createJobRunner({ studioDir });
  assert.equal(recovered.get(jobId).status, "done"); recovered.dispose();
  const edited = await submit({ project: { schemaVersion: 1, id: "edited-http", title: "修改完成", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "intro", kind: "title", title: "修改完成", narration: { text: "修改完成。" } }] }, template: "explainer", theme: "glint-dark", tts: "mock", encoding: "draft", requestId: randomUUID() });
  let editedStatus;
  const editedDeadline = Date.now() + 120_000;
  do {
    editedStatus = await (await fetch(`${origin}/api/make/${edited.jobId}`)).json();
    if (["done", "failed", "cancelled"].includes(editedStatus.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < editedDeadline);
  assert.equal(editedStatus.status, "done", "Edited SceneScript must render without recomposition or make-only flags");
  report.editorJob = editedStatus;
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", destination], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  report.video = JSON.parse(probe.stdout); report.bytes = bytes.length; report.status = "passed";
  console.log(`[glint-web] real CLI, queue/cancel, idempotency, recovery, Range and download passed: ${output}`);
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally {
  runner.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
