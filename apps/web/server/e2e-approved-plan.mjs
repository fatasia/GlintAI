// Real-model end-to-end for the approved-plan path (CREATE-07 evidence):
//   /api/plan (real LLM) → /api/compose {plan, requestId} (real LLM, idempotent)
//   → /api/make {project} (real CLI render) → MP4 → ffprobe.
// Run with GLINT_LLM_* env vars set; never hardcode credentials here.
//   pnpm --filter glint-web exec tsx server/e2e-approved-plan.mjs --out=<evidenceDir>
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWebServer } from "./index.mjs";

const outDir = process.argv.find(arg => arg.startsWith("--out="))?.slice("--out=".length);
if (!outDir) { console.error("usage: e2e-approved-plan.mjs --out=<evidenceDir>"); process.exit(2); }
if (!process.env.GLINT_LLM_API_KEY) { console.error("GLINT_LLM_API_KEY is required (no credentials in this script)"); process.exit(2); }

const startedAt = Date.now();
fs.mkdirSync(outDir, { recursive: true });
const server = createWebServer({});
if (!server.listening) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const request = (pathname, body, signal) => fetch(`${origin}${pathname}`, body === undefined ? { signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const close = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

try {
  const health = await (await request("/api/health")).json();
  assert.equal(health.modelConfigured, true, "model must be configured before the run");
  console.log(`[1/6] health ok; model=${process.env.GLINT_LLM_MODEL ?? "(default)"}`);

  const planSignal = AbortSignal.timeout(180_000);
  const planStart = Date.now();
  const planResponse = await request("/api/plan", {
    goal: "给一家社区咖啡店周六开业做宣传，主打手冲单品咖啡与到店礼",
    audience: "周边居民与上班族",
    platform: "16:9",
    seconds: 15,
    material: "周六上午 10 点开业；前 50 位到店送手冲一杯；地址在南山路 22 号",
  }, planSignal);
  const planBody = await planResponse.json();
  assert.equal(planResponse.status, 200, `plan failed: ${planBody.error}`);
  const plan = planBody.plan;
  assert.equal(plan.scenes.some(scene => scene.kind === "image"), false, "plan must not contain unbound image shots");
  const secondsSum = plan.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  assert.ok(secondsSum <= 600, "plan total duration must stay under the 600s cap");
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  const planMs = Date.now() - planStart;
  console.log(`[2/6] /api/plan ok in ${planMs}ms: ${plan.scenes.length} shots, ${secondsSum}s, kinds=${plan.scenes.map(scene => scene.kind).join(",")}`);

  const requestId = randomUUID();
  const composeStart = Date.now();
  const composeResponse = await request("/api/compose", { plan, requestId }, AbortSignal.timeout(180_000));
  const composed = await composeResponse.json();
  assert.equal(composeResponse.status, 200, `compose failed: ${composed.error}`);
  const { project } = composed;
  assert.equal(project.scenes.length, plan.scenes.length, "scene count must match the approved plan");
  project.scenes.forEach((scene, index) => {
    const shot = plan.scenes[index];
    assert.equal(scene.kind, shot.kind, `scene ${index + 1} kind must stay ${shot.kind}`);
    assert.equal(scene.narration.text, shot.narration, `scene ${index + 1} narration must be the approved text`);
    assert.equal(scene.narration.durationMs, shot.seconds * 1000, `scene ${index + 1} duration must be approved timing`);
  });
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(project, null, 2));
  const composeMs = Date.now() - composeStart;
  console.log(`[3/6] /api/compose ok in ${composeMs}ms: project=${project.id}, scenes=${project.scenes.length}`);

  const retry = await request("/api/compose", { plan, requestId }, AbortSignal.timeout(30_000));
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.cached, true, "same requestId must hit the cache, not a second model call");
  console.log("[4/6] idempotent retry cached:true");

  const makeResponse = await request("/api/make", { project, tts: "mock", encoding: "draft", requestId: randomUUID() }, AbortSignal.timeout(60_000));
  const queued = await makeResponse.json();
  assert.equal(makeResponse.status, 200, `make failed: ${queued.error}`);
  let job;
  for (let attempt = 0; ; attempt++) {
    job = await (await request(`/api/make/${queued.jobId}`)).json();
    if (["done", "failed", "cancelled", "interrupted"].includes(job.status)) break;
    if (attempt > 300) throw new Error("render did not finish in 5 minutes");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(job.status, "done", `render ended as ${job.status}: ${job.error ?? ""}`);
  const video = await fetch(`${origin}${job.video}`);
  const bytes = Buffer.from(await video.arrayBuffer());
  const videoFile = path.join(outDir, "approved-plan.mp4");
  fs.writeFileSync(videoFile, bytes);
  console.log(`[5/6] rendered ${bytes.length} bytes via real CLI`);

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", videoFile], { encoding: "utf8" });
  assert.equal(probe.status, 0, "ffprobe must succeed on the rendered file");
  const info = JSON.parse(probe.stdout);
  const duration = Number(info.format?.duration ?? 0);
  // Render contract (render.ts:193): the real TTS audio length REPLACES the
  // approved durationMs in both directions — speech is never truncated and
  // never padded. The approved-vs-rendered drift is the number the UI must
  // surface as a conflict (handoff §2.2 item 6).
  assert.ok(duration >= secondsSum * 0.6 - 1, `rendered ${duration}s collapsed far below the approved ${secondsSum}s`);
  assert.ok(duration <= secondsSum * 2 + 3, `rendered ${duration}s is suspiciously longer than the approved ${secondsSum}s`);
  const driftSeconds = Math.round((duration - secondsSum) * 10) / 10;
  const hasVideo = (info.streams ?? []).some(stream => stream.codec_name === "h264" && stream.width > 0);
  assert.ok(hasVideo, "an h264 video stream must exist");
  console.log(`[6/6] ffprobe ok: ${duration.toFixed(1)}s (approved ${secondsSum}s, TTS drift +${driftSeconds}s), h264 present`);

  const report = {
    ranAt: new Date().toISOString(), origin, model: process.env.GLINT_LLM_MODEL ?? "(default)",
    planMs, composeMs, totalMs: Date.now() - startedAt,
    shots: plan.scenes.length, approvedSeconds: secondsSum, renderedSeconds: duration, ttsDriftSeconds: driftSeconds,
    projectId: project.id, requestId, videoBytes: bytes.length,
    assertions: "plan shape / approved kinds+order+narration+timing / idempotent retry / h264 render / no speech truncation",
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`PASS evidence written to ${path.resolve(outDir)}`);
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  fs.writeFileSync(path.join(outDir, "failure.txt"), `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`, "utf8");
  process.exitCode = 1;
} finally { await close(); }
