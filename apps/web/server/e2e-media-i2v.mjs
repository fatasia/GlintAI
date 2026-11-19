// Real-gateway image-to-video e2e (GEN-10 i2v / GEN-11 first-last frame):
// submit → idempotent resubmit → poll → download → ingest gate → ffprobe,
// through Glint's own /api/media pipeline (not raw curl).
// Run with GLINT_MEDIA_* env; no credentials in this file.
//   pnpm --filter glint-web exec tsx server/e2e-media-i2v.mjs --out=<dir> --model=<id> --images=<file[,file2]> [--prompt=...] [--params=<json>] [--max-wait=<seconds>]
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const arg = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = arg("out"), model = arg("model"), images = arg("images"), maxWaitMs = Number(arg("max-wait") ?? 900) * 1000;
const prompt = arg("prompt") ?? "镜头缓慢推进，画面自然运动，短视频质感";
if (!outDir || !model || !images) { console.error("usage: e2e-media-i2v.mjs --out=<dir> --model=<id> --images=<file[,file2]> [--prompt=...] [--params=json] [--max-wait=seconds]"); process.exit(2); }
for (const key of ["GLINT_MEDIA_BASE_URL", "GLINT_MEDIA_API_KEY"]) if (!process.env[key]) { console.error(`${key} is required`); process.exit(2); }

const dataUrl = (file) => {
  const bytes = fs.readFileSync(file);
  const kind = path.extname(file).toLowerCase() === ".png" ? "png" : "jpeg";
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`image ${file} exceeds the 8 MiB inline limit`);
  return `data:image/${kind};base64,${bytes.toString("base64")}`;
};
const imageFiles = images.split(",").map(file => path.resolve(file));
for (const file of imageFiles) if (!fs.existsSync(file)) { console.error(`missing image: ${file}`); process.exit(2); }
const extraParams = arg("params") ? JSON.parse(arg("params")) : {};
const params = { images: imageFiles.map(dataUrl), ...extraParams };

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
  const submitResponse = await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "video", model, requestId, prompt, params }) });
  const submitted = await submitResponse.json();
  assert.equal(submitResponse.status, 202, `submit failed: ${JSON.stringify(submitted)}`);
  assert.match(submitted.taskId, /^[a-zA-Z0-9_-]+$/);
  console.log(`[1/4] submitted taskId=${submitted.taskId} model=${model} images=${imageFiles.length}`);

  const retry = await (await fetch(`${origin}/api/media/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "video", model, requestId, prompt, params }) })).json();
  assert.equal(retry.taskId, submitted.taskId, "same requestId must map to the same task");
  console.log("[2/4] idempotent resubmit ok");

  let task, waited = 0;
  for (;;) {
    task = await (await fetch(`${origin}/api/media/status/${submitted.taskId}`)).json();
    if (task.isFinal) break;
    if (Date.now() - startedAt > maxWaitMs) throw new Error(`video not final after ${maxWaitMs / 1000}s (state=${task.state})`);
    await new Promise(resolve => setTimeout(resolve, 5000)); waited += 5;
  }
  assert.equal(task.state, "success", `task ended as ${task.state}${task.error ? `: ${task.error}` : ""}`);
  assert.match(task.assetUrl, /^\/api\/media\/assets\//);
  console.log(`[3/4] task success after ~${waited}s; asset=${task.assetUrl} cost=${task.cost ?? "n/a"}`);

  const assetResponse = await fetch(`${origin}${task.assetUrl}`);
  const bytes = Buffer.from(await assetResponse.arrayBuffer());
  assert.ok(bytes.length > 20_000, `downloaded asset looks too small (${bytes.length} bytes)`);
  assert.equal(assetResponse.headers.get("content-type"), "video/mp4");
  const videoFile = path.join(outDir, "generated.mp4");
  fs.writeFileSync(videoFile, bytes);

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", videoFile], { encoding: "utf8" });
  assert.equal(probe.status, 0, "ffprobe must read the generated video (ingest gate passed)");
  const info = JSON.parse(probe.stdout);
  const videoStream = (info.streams ?? []).find(stream => stream.codec_name === "h264" || stream.codec_name === "hevc");
  assert.ok(videoStream?.width, "a video stream with dimensions must exist");
  const duration = Number(info.format?.duration ?? 0);
  assert.ok(duration >= 1, `duration ${duration}s looks wrong`);
  console.log(`[4/4] ffprobe ok: ${duration.toFixed(1)}s, ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}, ${bytes.length} bytes`);

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
    ranAt: new Date().toISOString(), model, requestId, taskId: submitted.taskId,
    inputImages: imageFiles, extraParams, cost: task.cost ?? null,
    waitSeconds: waited, durationSeconds: duration, codec: videoStream.codec_name,
    width: videoStream.width, height: videoStream.height, bytes: bytes.length,
    assertions: "submit 202 / idempotent resubmit / final success / ingest gate / mp4 content-type / codec+dimensions+duration",
  }, null, 2));
  console.log(`PASS evidence written to ${path.resolve(outDir)}`);
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  fs.writeFileSync(path.join(outDir, "failure.txt"), `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
} finally { await close(); }
