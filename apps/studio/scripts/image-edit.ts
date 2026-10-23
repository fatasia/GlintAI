import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { IMAGE_EDIT_PRESETS } from "@glintai/media/presets";
import { runMediaProcess } from "./native-process";
import os from "node:os";

export interface ImageEditOptions {
  src: string; prompt: string; out: string;
  model?: string;
  baseUrl?: string; apiKey?: string;
  size?: string; aspectRatio?: string;
  pollIntervalMs?: number; signal?: AbortSignal; publicDns?: boolean;
  mask?: string; taskId?: string;
}

export interface ImageVersionEntry {
  file: string; parent: string | null; parentSha256: string; sha256: string;
  model: string; prompt: string; cost?: number; taskId: string; at: string;
  maskSha256?: string;
}

export const VERSIONS_FILE = "versions.json";

/** Re-exported for CLI callers; the source of truth is @glintai/media so the web workshop shares it. */
export const EDIT_PRESETS: Record<string, string> = IMAGE_EDIT_PRESETS;

async function fetchJson(url: string, apiKey: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, "accept-language": "zh-CN" }, signal: signal ?? AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);
  return response.json();
}

/** Tags are language-dependent (gateway honours Accept-Language); match both. */
const EDIT_TAGS = ["图片编辑", "图生图", "多图参考", "参考", "Image editing", "Image-to-image", "Multi-image reference", "Reference"];

/** 最便宜的可用编辑模型:按 tags 过滤出编辑能力,再按 active 渠道最低 base_price 排序。 */
export async function pickCheapestEditModel(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<{ name: string; price: number }> {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const catalog = await fetchJson(`${base}/v1/skills/models?type=image`, apiKey, signal);
  const candidates = (catalog.models ?? []).filter((m: any) => m.available_for_this_key !== false && EDIT_TAGS.some(tag => (m.tags ?? []).includes(tag)));
  if (!candidates.length) throw new Error("网关没有支持图片编辑的模型(找 tags: 图片编辑/图生图)");
  let best: { name: string; price: number } | undefined;
  for (const candidate of candidates) {
    try {
      const pricing = await fetchJson(`${base}/v1/skills/models/${encodeURIComponent(candidate.name)}/pricing`, apiKey, signal);
      for (const group of pricing.channel_groups ?? []) {
        if (!group.is_active || group.excluded_for_this_key) continue;
        const price = group.min_price ?? group.base_price;
        if (Number.isFinite(price) && (!best || price < best.price)) best = { name: candidate.name, price };
      }
    } catch { /* 单模型定价失败不阻塞其它候选 */ }
  }
  if (!best) throw new Error("编辑模型均无可用定价,请用 --model 显式指定");
  return best;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Non-destructive image edit: the source file is never touched; the result is
 * written to a new path and appended to versions.json next to it, forming a
 * replayable edit chain, file-based and portable.
 * Paid submissions are never retried automatically.
 */
export async function imageEdit(options: ImageEditOptions) {
  // Local guards first — never touch the network (or spend) on a bad request.
  const source = path.resolve(options.src), output = path.resolve(options.out);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Source image not found: ${source}`);
  if (fs.existsSync(output)) throw new Error(`Output already exists; image editing is non-destructive, choose a new --out`);
  const bytes = fs.readFileSync(source);
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`Source image exceeds the 8 MiB inline limit (${bytes.length} bytes); host it at a public URL and pass params manually`);
  if (!options.prompt.trim()) throw new Error("请输入编辑提示词");
  if (options.mask && (!fs.statSync(options.mask).isFile() || fs.statSync(options.mask).size > 8 * 1024 * 1024)) throw new Error("Mask must be a PNG smaller than 8 MiB");
  const chainFile = path.join(path.dirname(output), VERSIONS_FILE);
  const readChain = (): ImageVersionEntry[] => {
    const chain = fs.existsSync(chainFile) ? JSON.parse(fs.readFileSync(chainFile, "utf8")) : [];
    if (!Array.isArray(chain)) throw new Error(`${chainFile} is not a version list`);
    return chain;
  };
  readChain();
  const journalFile = `${output}.task.json`;
  const existing = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, "utf8")) : undefined;
  if (existing && !options.taskId) throw new Error(`Task already submitted; resume with --task=${existing.taskId}. Do not resubmit.`);
  if (existing && (existing.taskId !== options.taskId || existing.parentSha256 !== sha256(bytes) || existing.prompt !== options.prompt || existing.maskSha256 !== (options.mask ? sha256(fs.readFileSync(options.mask)) : undefined))) throw new Error("恢复任务与原始源图、蒙版或提示词不一致");
  let model = options.model;
  if (!model && !options.taskId) {
    if (!options.baseUrl || !options.apiKey) throw new Error("Configure GLINT_MEDIA_BASE_URL and GLINT_MEDIA_API_KEY, or pass --model");
    const cheapest = await pickCheapestEditModel(options.baseUrl, options.apiKey, options.signal);
    model = cheapest.name;
    console.log(`[media] auto-selected cheapest edit model: ${model} (~${cheapest.price}/次)`);
  }
  if (!options.baseUrl || !options.apiKey) throw new Error("Configure GLINT_MEDIA_BASE_URL and GLINT_MEDIA_API_KEY for image editing");
  const client = new MediaGatewayClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, pollIntervalMs: options.pollIntervalMs });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Reserve before spending. An ambiguous submission is not safe to retry.
  if (!existing) fs.writeFileSync(journalFile, JSON.stringify({ state: "submitting", taskId: options.taskId, parent: path.basename(source), parentSha256: sha256(bytes), prompt: options.prompt, model, maskSha256: options.mask ? sha256(fs.readFileSync(options.mask)) : undefined }), { flag: "wx" });
  const taskId = options.taskId ?? await client.submit(model!, options.prompt, { images: [`data:image/${path.extname(source).slice(1).toLowerCase() === "jpg" ? "jpeg" : path.extname(source).slice(1).toLowerCase()};base64,${bytes.toString("base64")}`], ...(options.size ? { size: options.size } : {}), ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}) }, options.signal ?? AbortSignal.timeout(30000));
  const journal = { state: "submitted", taskId, parent: path.basename(source), parentSha256: sha256(bytes), prompt: options.prompt, model: model ?? existing?.model ?? "recovered", maskSha256: options.mask ? sha256(fs.readFileSync(options.mask)) : undefined };
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  console.log(`[media] image task=${taskId}; resume with glint media --task=${taskId}`);
  const task = await client.wait(taskId, { signal: options.signal, timeoutMs: options.signal ? undefined : 600000 });
  const result = await downloadMediaResult(task, options.signal ?? AbortSignal.timeout(120000), { publicDns: options.publicDns });
  if (!result.contentType.startsWith("image/")) throw new Error(`Model returned ${result.contentType}, not an image; no charge reversal is possible here`);
  let finalBytes: Buffer = Buffer.from(result.bytes);
  if (options.mask) finalBytes = await compositeMaskedEdit(source, result.bytes, options.mask, options.signal);
  const lockFile = `${chainFile}.lock`, lock = fs.openSync(lockFile, "wx");
  try {
    const chain = readChain();
    fs.writeFileSync(output, finalBytes, { flag: "wx" });
    chain.push({ file: path.basename(output), parent: path.basename(source), parentSha256: sha256(bytes), sha256: sha256(finalBytes), model: journal.model, prompt: options.prompt, cost: task.cost, taskId, at: new Date().toISOString(), ...(journal.maskSha256 ? { maskSha256: journal.maskSha256 } : {}) });
    const temp = `${chainFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(chain, null, 2)); fs.renameSync(temp, chainFile);
    fs.writeFileSync(journalFile, JSON.stringify({ ...journal, state: "completed", cost: task.cost }, null, 2));
  } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  return { output, bytes: finalBytes.length, contentType: options.mask ? "image/png" : result.contentType, cost: task.cost, taskId, chain: chainFile };
}

/** White edits, black preserves. Composite locally so the model cannot alter unselected pixels. */
export async function compositeMaskedEdit(source: string, generated: Uint8Array, mask: string, signal?: AbortSignal): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-mask-"));
  try {
    const edit = path.join(dir, "edit.png"), out = path.join(dir, "result.png"); fs.writeFileSync(edit, generated);
    await runMediaProcess("ffmpeg", ["-v", "error", "-i", source, "-i", edit, "-i", mask, "-filter_complex", "[1:v][0:v]scale2ref[edit][src];[2:v][src]scale2ref[mask][base];[base]format=gbrap[b];[edit]format=gbrap[e];[mask]format=gray[m];[b][e][m]maskedmerge,format=rgba[out]", "-map", "[out]", "-frames:v", "1", "-threads", "1", out], { signal });
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
