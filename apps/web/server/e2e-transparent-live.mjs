// One paid reference-image probe. Never repeat an uncertain request.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileSessionStore } from "@glintai/session/node";
import { canonicalJson } from "@glintai/session";
import { parseProject } from "@glintai/scenescript";
import { createMediaJobs } from "./media-jobs.mjs";
import { createWebServer } from "./index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(repo, "evidence", "GEN-08", "live-transparent-20261027-b");
if (fs.existsSync(out)) throw new Error("Evidence exists; inspect receipts instead of resubmitting.");
if (process.env.GLINT_TRANSPARENT_LIVE_CONFIRM !== "1") throw new Error("Explicit one-shot confirmation required.");
if (!process.env.GLINT_MEDIA_BASE_URL || !process.env.GLINT_MEDIA_API_KEY) throw new Error("Media gateway configuration missing.");
fs.mkdirSync(out); const media = path.join(out, "media"); fs.mkdirSync(media);
const png = path.join(media, "source.png");
const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=256x256,drawbox=x=64:y=64:w=128:h=128:color=red:t=fill", "-frames:v", "1", "-threads", "1", "-y", png], { encoding: "utf8" });
if (generated.status !== 0) throw new Error("Failed to create the independent source image.");
const bytes = fs.readFileSync(png);
const progress = { model: "tt-image-2.5", requestId: randomUUID(), stage: "preparing", startedAt: new Date().toISOString(), inputSha256: createHash("sha256").update(bytes).digest("hex") };
const save = () => fs.writeFileSync(path.join(out, "progress.json"), JSON.stringify(progress, null, 2));
save();
const jobs = createMediaJobs(media, process.env);
const store = new FileSessionStore(path.join(out, "sessions"), value => { parseProject(value); });
const server = createWebServer({ mediaJobs: jobs, sessionStore: store, requestLogDir: path.join(out, "logs") });
let listening = false;
try {
  const model = (await jobs.models("image")).find(item => item.id === progress.model);
  if (!model?.tags?.some(tag => ["图生图", "Image-to-image"].includes(tag)) ||
      !model.tags.some(tag => ["透明背景", "Transparent background"].includes(tag))) throw new Error("Gateway no longer declares the required reference and transparency capabilities.");
  const pricing = await jobs.pricing(progress.model);
  const channels = (pricing.channel_groups ?? []).filter(g => g.is_active && g.in_key_whitelist && !g.excluded_for_this_key && g.billing_method === "按次" &&
    Number.isFinite(g.base_price) && (!g.supported_options?.background || g.supported_options.background.includes("transparent")) &&
    (!g.supported_options?.resolution || g.supported_options.resolution.includes("1K")) &&
    (!g.supported_options?.version || g.supported_options.version.includes("flare")));
  if (!channels.length || channels.some(g => g.base_price > 0.5 || (g.input_image_price ?? 0) > 0 || (g.option_prices ?? []).some(o =>
    ((o.param_name === "resolution" && o.option_value === "1K") || (o.param_name === "version" && o.option_value === "flare") ||
      (o.param_name === "background" && o.option_value === "transparent") || (o.param_name === "aspect_ratio" && o.option_value === "1:1") ||
      (o.param_name === "quality" && o.option_value === "auto")) &&
    ((o.price_multiplier ?? 1) !== 1 || (o.price_addition ?? 0) !== 0)))) throw new Error("Price or eligible channel changed; no request was sent.");
  const base = process.env.GLINT_MEDIA_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
  const balanceResponse = await fetch(base + "/v1/skills/balance", { headers: { authorization: `Bearer ${process.env.GLINT_MEDIA_API_KEY}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!balanceResponse.ok) throw new Error("Balance preflight failed.");
  const balance = (await balanceResponse.json()).balance;
  if (!Number.isFinite(balance) || balance < 1) throw new Error("Insufficient balance for the approved probe.");
  progress.balanceBefore = balance; progress.priceRange = [Math.min(...channels.map(g => g.base_price)), Math.max(...channels.map(g => g.base_price))]; save();
  const project = parseProject({ schemaVersion: 1, id: "transparent-live", title: "透明背景测试", aspect: "1:1", knowledgeSources: [],
    assets: [{ id: "shape", kind: "character", name: "红色方块", version: "v1", description: "红色方块", voice: "test-voice", refs: ["assets/source.png"] }],
    scenes: [{ id: "one", kind: "image", src: "assets/source.png", assetRefs: [{ assetId: "shape", version: "v1" }], narration: { text: "红色方块透明背景", durationMs: 2000 } }] });
  store.open(project.id, project);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); listening = true;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(origin + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  const approvalResponse = await post("/api/session/approve-character", { projectId: project.id, assetId: "shape", transactionId: `approve-${randomUUID()}`, baseRevision: 0 });
  if (!approvalResponse.ok) throw new Error(`Reference approval failed (HTTP ${approvalResponse.status}).`);
  const approval = await approvalResponse.json(), current = parseProject(approval.snapshot.document), scene = current.scenes[0];
  const basis = canonicalJson({ projectId: current.id, aspect: current.aspect, scene, assets: scene.assetRefs.map(ref => current.assets.find(item => item.id === ref.assetId)) });
  progress.stage = "submission-started"; save();
  const submitted = await post("/api/media/submit", { type: "image", model: progress.model, requestId: progress.requestId,
    prompt: "以参考图中的红色方块为主体，移除白色背景，保留完整红色方块，输出真正透明背景的 PNG。",
    params: { version: "flare", resolution: "1K", aspect_ratio: "1:1", background: "transparent", quality: "auto" },
    reference: { projectId: current.id, sceneId: scene.id, assetId: "shape", basis } });
  if (!submitted.ok) throw new Error(`Submission outcome unconfirmed (HTTP ${submitted.status}); inspect request receipt, do not retry.`);
  const response = await submitted.json(); if (!response.taskId) throw new Error("No task ID; inspect receipt, do not retry.");
  progress.taskId = response.taskId; progress.stage = "submitted"; save();
  let task;
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await fetch(origin + `/api/media/status/${encodeURIComponent(response.taskId)}`, { signal: AbortSignal.timeout(30000) });
    if (!status.ok) throw new Error(`Status failed (HTTP ${status.status}); inspect task without resubmitting.`);
    task = await status.json(); progress.state = task.state; save(); if (task.isFinal) break;
  }
  if (!task?.isFinal || task.state !== "success" || typeof task.assetUrl !== "string") throw new Error("Task did not complete successfully; inspect its ID, do not retry.");
  const asset = path.join(media, path.basename(task.assetUrl)), result = fs.readFileSync(asset);
  progress.stage = "downloaded"; progress.cost = task.cost ?? null; progress.output = path.basename(asset); progress.outputSha256 = createHash("sha256").update(result).digest("hex"); save();
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", asset], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error("Cannot inspect image dimensions.");
  const image = JSON.parse(probe.stdout).streams?.[0];
  if (!image?.width || !image?.height || image.width * image.height > 16_777_216) throw new Error("Output dimensions invalid.");
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", asset, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 70 * 1024 * 1024 });
  if (raw.status !== 0 || raw.stdout.length !== image.width * image.height * 4) throw new Error("Cannot inspect decoded image pixels.");
  let transparent = 0, opaque = 0; for (let i = 3; i < raw.stdout.length; i += 4) { if (raw.stdout[i] === 0) transparent++; if (raw.stdout[i] === 255) opaque++; }
  Object.assign(progress, { width: image.width, height: image.height, pixelFormat: image.pix_fmt, transparentPixels: transparent, opaquePixels: opaque }); save();
  if (!transparent || !opaque) throw new Error("Output is not a mixture of transparent and opaque pixels.");
  progress.stage = "verified"; progress.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify(progress));
} catch (error) { progress.error = error instanceof Error ? error.message : "Unexpected probe error"; save(); console.error("Probe stopped:", progress.error); process.exitCode = 1; }
finally { if (listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
