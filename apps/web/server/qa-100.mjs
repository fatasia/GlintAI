// QA-06: 100-run real-gateway success-rate measurement through /api/media.
//   GLINT_MEDIA_* env required; node qa-100.mjs --runs=100 --model=doubao-seedream-5-0-pro-260628 --out=<dir>
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const arg = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(arg("runs") ?? 100), model = arg("model") ?? "doubao-seedream-5-0-pro-260628", outDir = arg("out") ?? path.join("evidence", "QA-06", `run-${new Date().toISOString().slice(0, 10)}`);
if (!process.env.GLINT_MEDIA_BASE_URL || !process.env.GLINT_MEDIA_API_KEY) { console.error("GLINT_MEDIA_* required"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const mediaJobs = createMediaJobs(path.join(outDir, "media"), process.env);
const server = createWebServer({ mediaJobs });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reportFile = path.join(outDir, "runs.jsonl");
const startedAt = Date.now();
let ok = 0, failed = 0, cost = 0;
const durations = [];
const durationStats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1], mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) };
};
for (let index = 1; index <= runs; index++) {
  const requestId = randomUUID();
  const runStartedAt = Date.now();
  const entry = { index, model, startedAt: new Date().toISOString() };
  try {
    const submit = await (await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image", model, requestId, prompt: `极简测试图 #${index}：纯色背景中央一个白色圆`, params: {} }), signal: AbortSignal.timeout(120_000) })).json();
    assert.ok(submit.taskId, `submit no taskId: ${JSON.stringify(submit).slice(0, 200)}`);
    let task;
    for (;;) {
      task = await (await fetch(`${origin}/api/media/status/${submit.taskId}`, { signal: AbortSignal.timeout(60_000) })).json();
      if (task.isFinal) break;
      if (Date.now() - runStartedAt > 480_000) throw new Error("per-run timeout");
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    if (task.state !== "success") throw new Error(`state=${task.state}`);
    const asset = await fetch(`${origin}${task.assetUrl}`, { signal: AbortSignal.timeout(60_000) });
    if (!asset.ok) throw new Error(`asset HTTP ${asset.status}`);
    const bytes = Buffer.from(await asset.arrayBuffer());
    if (bytes.length < 10_000) throw new Error(`asset too small (${bytes.length})`);
    ok++; cost += Number(task.cost ?? 0);
    entry.ok = true; entry.cost = task.cost; entry.seconds = Math.round((Date.now() - runStartedAt) / 1000); durations.push(entry.seconds);
  } catch (error) {
    failed++; entry.ok = false; entry.error = String(error instanceof Error ? error.message : error).slice(0, 200);
  }
  entry.totalCost = Number(cost.toFixed(4));
  fs.appendFileSync(reportFile, JSON.stringify(entry) + "\n");
  console.log(`[${index}/${runs}] ${entry.ok ? "ok" : "FAIL"} ${entry.error ?? ""} cost=${entry.totalCost}`);
  if (Date.now() - startedAt > 4 * 3_600_000) { console.log("stop: 4h total budget"); break; }
  await new Promise(resolve => setTimeout(resolve, 8000)); // gateway rate limit: no burst submissions
  if (!entry.ok && failed >= 20) { console.log("abort: 20 failures"); break; }
}
server.closeAllConnections(); server.close();
const summary = { ranAt: new Date().toISOString(), model, requested: runs, ok, failed, successRate: Number((ok / (ok + failed) * 100).toFixed(1)), totalCost: Number(cost.toFixed(2)), duration: durations.length ? durationStats(durations) : null, wallMinutes: Number(((Date.now() - startedAt) / 60000).toFixed(1)) };
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("SUMMARY", JSON.stringify(summary));
process.exit(0);
