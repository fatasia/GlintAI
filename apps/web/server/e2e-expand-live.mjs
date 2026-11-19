// One paid reference expansion probe. An existing evidence directory stops it.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMediaJobs } from "./media-jobs.mjs";
import { createWebServer } from "./index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(repo, "evidence", "GEN-08", "live-expand-20261027");
const original = path.join(repo, "evidence", "GEN-06", "run-20261024-image", "media", "186803994.jpg");
if (fs.existsSync(out)) throw new Error("Evidence already exists; inspect the request, never resubmit automatically.");
if (process.env.GLINT_EXPAND_LIVE_CONFIRM !== "1") throw new Error("Explicit one-shot confirmation required.");
if (!process.env.GLINT_MEDIA_BASE_URL || !process.env.GLINT_MEDIA_API_KEY || !fs.existsSync(original)) throw new Error("Gateway or source image is unavailable.");
fs.mkdirSync(out); const media = path.join(out, "media"); fs.mkdirSync(media);
const canvas = path.join(media, "canvas.png");
execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", original, "-vf", "scale=1044:586:force_original_aspect_ratio=decrease,pad=1536:864:(ow-iw)/2:(oh-ih)/2:white", "-frames:v", "1", "-threads", "1", canvas], { timeout: 30000 });
const bytes = fs.readFileSync(canvas);
if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Expanded reference exceeds the size limit.");
const progress = { model: "tt-image-2.5", targetSize: "1536x864", requestId: randomUUID(), stage: "preparing", startedAt: new Date().toISOString(), originalSha256: createHash("sha256").update(fs.readFileSync(original)).digest("hex"), canvasSha256: createHash("sha256").update(bytes).digest("hex") };
const save = () => fs.writeFileSync(path.join(out, "progress.json"), JSON.stringify(progress, null, 2)); save();
const jobs = createMediaJobs(media, process.env);
const server = createWebServer({ mediaJobs: jobs, requestLogDir: path.join(out, "logs") });
let listening = false;
try {
  const model = (await jobs.models("image")).find(item => item.id === progress.model);
  if (!model?.tags?.some(tag => ["图生图", "Image-to-image"].includes(tag))) throw new Error("Model does not declare reference-image editing.");
  const pricing = await jobs.pricing(progress.model);
  const channels = (pricing.channel_groups ?? []).filter(g => g.is_active && g.in_key_whitelist && !g.excluded_for_this_key && g.billing_method === "按次" &&
    Number.isFinite(g.base_price) && (!g.supported_options?.background || g.supported_options.background.includes("opaque")));
  if (!channels.length || channels.some(g => g.base_price > 0.5 || (g.input_image_price ?? 0) > 0 ||
    (g.option_prices ?? []).some(o => ((o.param_name === "size" && o.option_value === progress.targetSize) ||
      (o.param_name === "version" && o.option_value === "flare") || (o.param_name === "background" && o.option_value === "opaque") ||
      (o.param_name === "quality" && o.option_value === "auto")) && ((o.price_multiplier ?? 1) !== 1 || (o.price_addition ?? 0) !== 0)))) throw new Error("Price or candidate channels changed; no request was sent.");
  const base = process.env.GLINT_MEDIA_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
  const balanceResponse = await fetch(base + "/v1/skills/balance", { headers: { authorization: `Bearer ${process.env.GLINT_MEDIA_API_KEY}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!balanceResponse.ok) throw new Error("Balance preflight failed.");
  const balance = (await balanceResponse.json()).balance;
  if (!Number.isFinite(balance) || balance < 1) throw new Error("Insufficient balance for the approved probe.");
  progress.balanceBefore = balance; progress.basePriceRange = [Math.min(...channels.map(g => g.base_price)), Math.max(...channels.map(g => g.base_price))]; save();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); listening = true;
  const origin = `http://127.0.0.1:${server.address().port}`;
  progress.stage = "submission-started"; save();
  const submitted = await fetch(origin + "/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(150000), body: JSON.stringify({
    type: "image", model: progress.model, requestId: progress.requestId,
    prompt: "以参考图中央画面为依据，自然延展场景，补全四周白色留白，使整幅画面连续完整；尽量保持中央主体外观、比例和风格，不要白边或相框。",
    params: { version: "flare", size: progress.targetSize, background: "opaque", quality: "auto" },
    libraryReference: { name: "canvas.png", sha256: progress.canvasSha256 },
  }) });
  if (!submitted.ok) throw new Error(`Submission outcome unconfirmed (HTTP ${submitted.status}); inspect receipt, do not retry.`);
  const value = await submitted.json(); if (!value.taskId) throw new Error("No task ID; inspect receipt, do not retry.");
  progress.taskId = value.taskId; progress.stage = "submitted"; save();
  let task;
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await fetch(origin + `/api/media/status/${encodeURIComponent(value.taskId)}`, { signal: AbortSignal.timeout(30000) });
    if (!status.ok) throw new Error(`Status/download failed (HTTP ${status.status}); inspect task without resubmitting.`);
    task = await status.json(); progress.state = task.state; save(); if (task.isFinal) break;
  }
  if (!task?.isFinal || task.state !== "success" || typeof task.assetUrl !== "string") throw new Error("Task did not finish successfully; inspect task ID, do not retry.");
  const file = path.join(media, path.basename(task.assetUrl)), output = fs.readFileSync(file);
  progress.stage = "downloaded"; progress.cost = task.cost ?? null; progress.output = path.basename(file); progress.outputSha256 = createHash("sha256").update(output).digest("hex"); save();
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error("Cannot inspect output image.");
  const image = JSON.parse(probe.stdout).streams?.[0]; Object.assign(progress, { width: image?.width, height: image?.height, pixelFormat: image?.pix_fmt }); save();
  if (image?.width !== 1536 || image?.height !== 864) throw new Error("Output dimensions differ from the requested target.");
  progress.stage = "verified-size"; progress.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(progress));
} catch (error) { progress.error = error instanceof Error ? error.message : "Unexpected probe error"; save(); console.error("Probe stopped:", progress.error); process.exitCode = 1; }
finally { if (listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
