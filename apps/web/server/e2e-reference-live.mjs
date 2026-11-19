// One-shot paid verification. A pre-existing evidence directory always stops
// the script; recover uncertain tasks from its request receipt, never rerun.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { createMediaJobs } from "./media-jobs.mjs";
import { createWebServer } from "./index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(repo, "evidence", "DRAMA-03", "live-reference-20261027");
const source = path.join(repo, "evidence", "GEN-06", "run-20261024-image", "media", "186803994.jpg");
if (fs.existsSync(out)) throw new Error("Evidence directory already exists; inspect its receipts, do not resubmit.");
if (process.env.GLINT_LIVE_REFERENCE_CONFIRM !== "1") throw new Error("Set GLINT_LIVE_REFERENCE_CONFIRM=1 only after checking the evidence and price.");
if (!process.env.GLINT_MEDIA_BASE_URL || !process.env.GLINT_MEDIA_API_KEY) throw new Error("Media gateway configuration is missing.");
const bytes = fs.readFileSync(source);
if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Reference image is invalid.");
fs.mkdirSync(out); const media = path.join(out, "media"); fs.mkdirSync(media);
fs.writeFileSync(path.join(media, "coffee.jpg"), bytes, { flag: "wx" });
const requestId = randomUUID(), approvalId = `approve-${randomUUID()}`, adoptionId = `adopt-${randomUUID()}`;
const progress = { model: "tt-image-2.5", requestId, stage: "preparing", startedAt: new Date().toISOString(), referenceSha256: createHash("sha256").update(bytes).digest("hex") };
const record = () => fs.writeFileSync(path.join(out, "progress.json"), JSON.stringify(progress, null, 2));
record();
const project = parseProject({ schemaVersion: 1, id: "live-ref-coffee", title: "参考图链路验收", aspect: "16:9", knowledgeSources: [],
  assets: [{ id: "kettle", kind: "character", name: "手冲咖啡器具", version: "v1", description: "白色鹅颈手冲壶、白色滤纸与透明玻璃咖啡壶", voice: "test-voice", refs: ["assets/coffee.jpg"] }],
  scenes: [{ id: "one", kind: "image", src: "assets/coffee.jpg", assetRefs: [{ assetId: "kettle", version: "v1" }], narration: { text: "咖啡器具换一个视角", durationMs: 2000 } }] });
const jobs = createMediaJobs(media, process.env);
const store = new FileSessionStore(path.join(out, "sessions"), value => { parseProject(value); });
const server = createWebServer({ mediaJobs: jobs, sessionStore: store, requestLogDir: path.join(out, "logs") });
let listening = false;
try {
  const catalog = await jobs.models("image"), selected = catalog.find(item => item.id === progress.model);
  if (!selected?.tags?.some(tag => ["图片编辑", "图生图", "多图参考", "参考", "Image editing", "Image-to-image", "Multi-image reference", "Reference"].includes(tag))) throw new Error("Model does not advertise image-reference support.");
  const pricing = await jobs.pricing(progress.model);
  const active = (pricing.channel_groups ?? []).filter(group => group.is_active && group.in_key_whitelist && !group.excluded_for_this_key && Number.isFinite(group.base_price));
  if (!active.length) throw new Error("No active price card.");
  progress.minBasePrice = Math.min(...active.map(group => group.base_price)); record();
  if (progress.minBasePrice > 0.05) throw new Error("Price exceeds the probe's 0.05 base-price ceiling.");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); listening = true;
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  store.open(project.id, project);
  const approve = await post("/api/session/approve-character", { projectId: project.id, assetId: "kettle", transactionId: approvalId, baseRevision: 0 });
  if (!approve.ok) throw new Error(`Approval failed (HTTP ${approve.status}).`);
  const approved = await approve.json(), current = parseProject(approved.snapshot.document), scene = current.scenes[0];
  const basis = canonicalJson({ projectId: current.id, aspect: current.aspect, scene, assets: scene.assetRefs.map(ref => current.assets.find(item => item.id === ref.assetId)) });
  progress.stage = "submission-started"; record();
  const submitted = await post("/api/media/submit", { type: "image", model: progress.model, prompt: "以参考图片中的白色鹅颈手冲壶、滤纸和透明玻璃咖啡壶为主体，保持器具外观与材质，改为从侧前方拍摄的自然咖啡馆画面。", params: {}, requestId,
    reference: { projectId: current.id, sceneId: scene.id, assetId: "kettle", basis } });
  if (!submitted.ok) throw new Error(`Submission outcome unconfirmed (HTTP ${submitted.status}); inspect receipts before any retry.`);
  const result = await submitted.json();
  if (typeof result.taskId !== "string") throw new Error("Submission returned no task ID; inspect receipts before retry.");
  progress.taskId = result.taskId; progress.stage = "submitted"; record();
  let task;
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const response = await fetch(`${base}/api/media/status/${encodeURIComponent(result.taskId)}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Status failed (HTTP ${response.status}); inspect the task without resubmitting.`);
    task = await response.json(); progress.state = task.state; record();
    if (task.isFinal) break;
  }
  if (!task?.isFinal || task.state !== "success" || typeof task.assetUrl !== "string") throw new Error("Task did not finish successfully; inspect its task ID before retry.");
  const provenance = jobs.referenceCandidate(result.taskId);
  progress.stage = "downloaded"; progress.cost = task.cost ?? null; progress.output = provenance.candidate;
  progress.outputSha256 = createHash("sha256").update(fs.readFileSync(path.join(media, provenance.candidate))).digest("hex"); record();
  const adopted = await post("/api/session/adopt-reference-candidate", { projectId: current.id, taskId: result.taskId, transactionId: adoptionId, baseRevision: approved.look.revision, mode: "replace" });
  if (!adopted.ok) throw new Error(`Candidate adoption failed (HTTP ${adopted.status}).`);
  const adoptedValue = await adopted.json();
  if (adoptedValue.snapshot.document.scenes[0].src !== `assets/${provenance.candidate}`) throw new Error("Adopted project did not read back the candidate.");
  progress.stage = "adopted"; progress.adoptRevision = adoptedValue.look.revision; record();
  const undone = await post("/api/session/undo", { projectId: current.id, transactionId: `undo-${randomUUID()}`, baseRevision: adoptedValue.look.revision, actor: "user" });
  if (!undone.ok || (await undone.json()).snapshot.document.scenes[0].src !== "assets/coffee.jpg") throw new Error("Undo did not restore the original shot.");
  progress.stage = "verified"; progress.finishedAt = new Date().toISOString(); record();
  console.log(JSON.stringify(progress));
} catch (error) {
  progress.error = error instanceof Error ? error.message : "Unexpected error"; record();
  console.error("Probe stopped:", progress.error); process.exitCode = 1;
} finally {
  if (listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
