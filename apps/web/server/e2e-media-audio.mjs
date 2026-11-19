// Real-gateway audio generation e2e (GEN-05): TTS/music submit → poll → download
// → library → ffprobe, through Glint's own /api/media pipeline (not raw curl).
// Run with GLINT_MEDIA_* env; no credentials in this file.
//   pnpm --filter glint-web exec tsx server/e2e-media-audio.mjs --out=<dir> --model=<id> [--prompt=text] [--params=JSON] [--max-wait=seconds]
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const arg = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = arg("out"), model = arg("model") ?? "doubao-tts-2.0", maxWaitMs = Number(arg("max-wait") ?? 300) * 1000;
const prompt = arg("prompt") ?? "清晨的阳光洒进窗台，新的一天开始了。让我们用三分钟，看看这段画面如何被一帧帧组装成片。";
const params = arg("params") ? JSON.parse(arg("params")) : {};
if (!outDir) { console.error("usage: e2e-media-audio.mjs --out=<dir> [--model=id] [--prompt=text] [--params=JSON] [--max-wait=seconds]"); process.exit(2); }
for (const key of ["GLINT_MEDIA_BASE_URL", "GLINT_MEDIA_API_KEY"]) if (!process.env[key]) { console.error(`${key} is required`); process.exit(2); }

fs.mkdirSync(outDir, { recursive: true });
const root = path.join(outDir, "media");
const mediaJobs = createMediaJobs(root, process.env);
const server = createWebServer({ mediaJobs });
if (!server.listening) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const close = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const startedAt = Date.now();

try {
  const requestId = randomUUID();
  const submitResponse = await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    type: "audio", model, requestId, prompt, params,
  }) });
  const submitted = await submitResponse.json();
  assert.equal(submitResponse.status, 202, `submit failed: ${JSON.stringify(submitted)}`);
  assert.match(submitted.taskId, /^[a-zA-Z0-9_-]+$/);
  console.log(`[1/4] submitted taskId=${submitted.taskId} model=${model}`);

  // Idempotent resubmit with the same requestId returns the same task, no double billing.
  const retry = await (await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "audio", model, requestId, prompt, params }) })).json();
  assert.equal(retry.taskId, submitted.taskId, "same requestId must map to the same task");
  console.log("[2/4] idempotent resubmit ok");

  let task, waited = 0;
  for (;;) {
    task = await (await fetch(`${origin}/api/media/status/${submitted.taskId}`)).json();
    if (task.isFinal) break;
    if (Date.now() - startedAt > maxWaitMs) throw new Error(`audio not final after ${maxWaitMs / 1000}s (state=${task.state})`);
    await new Promise(resolve => setTimeout(resolve, 3000)); waited += 3;
  }
  assert.equal(task.state, "success", `task ended as ${task.state}: ${JSON.stringify(task).slice(0, 400)}`);
  assert.match(task.assetUrl, /^\/api\/media\/assets\//);
  console.log(`[3/4] task success after ~${waited}s; asset=${task.assetUrl}`);

  const assetResponse = await fetch(`${origin}${task.assetUrl}`);
  const bytes = Buffer.from(await assetResponse.arrayBuffer());
  assert.ok(bytes.length > 2000, `downloaded asset looks too small (${bytes.length} bytes)`);
  const contentType = assetResponse.headers.get("content-type") ?? "";
  assert.match(contentType, /^audio\//, `content-type must be audio, got ${contentType}`);
  const audioFile = path.join(outDir, `generated${contentType.includes("wav") ? ".wav" : ".mp3"}`);
  fs.writeFileSync(audioFile, bytes);

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels", "-of", "json", audioFile], { encoding: "utf8" });
  assert.equal(probe.status, 0, "ffprobe must read the generated audio");
  const info = JSON.parse(probe.stdout);
  const audioStream = (info.streams ?? []).find(stream => stream.codec_name);
  assert.ok(audioStream, "an audio stream must exist");
  const duration = Number(info.format?.duration ?? 0);
  assert.ok(duration >= 1, `duration ${duration}s looks wrong`);
  console.log(`[4/4] ffprobe ok: ${duration.toFixed(1)}s, ${audioStream.codec_name} ${audioStream.sample_rate ?? "?"}Hz ${audioStream.channels ?? "?"}ch, ${bytes.length} bytes, ${contentType}`);

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
    ranAt: new Date().toISOString(), model, requestId, taskId: submitted.taskId,
    prompt, params, waitSeconds: waited, durationSeconds: duration,
    codec: audioStream.codec_name, sampleRate: audioStream.sample_rate, channels: audioStream.channels,
    contentType, bytes: bytes.length,
    assertions: "submit 202 / idempotent resubmit / final success / audio content-type / ffprobe audio stream + duration",
  }, null, 2));
  console.log(`PASS evidence written to ${path.resolve(outDir)}`);
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  fs.writeFileSync(path.join(outDir, "failure.txt"), `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
} finally { await close(); }
