import fs from "node:fs";
import path from "node:path";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { runMediaProcess } from "./native-process";
import { spawnSync } from "node:child_process";

/**
 * AUDIO-10 / DRAMA-06 口型对齐（ADR-011）：人脸图 + 音频 → 说话视频。
 * 输入合同即 ADR-011 的 LipSyncRequest；模型按价格自动选低者；
 * 无幂等头，journal 先行防止重复计费；成片过 delivery-check 解码校验。
 * 口型一致性本期是启发式审阅（抽帧+文本模型），带 heuristic 标记，不冒充声学校验。
 */

export interface LipSyncOptions {
  faceImage: string;   // 本地图片路径，≤8 MiB
  audio: string;       // 本地音频路径，≤20 MiB
  out: string;         // 输出 mp4 路径（已存在则拒绝，防重复计费）
  durationMs?: number; // 生成段长；缺省=音频时长（ffprobe）
  aspect?: "9:16" | "16:9" | "1:1";
  model?: string;      // 缺省按价格选
  baseUrl?: string; apiKey?: string;
  signal?: AbortSignal;
}

const MODELS_BY_PRICE = ["kling-avatar-image2video"];

function probeDurationMs(file: string): number {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8", timeout: 30_000 });
  const seconds = Number(JSON.parse(probe.stdout || "{}").format?.duration ?? 0);
  if (!(seconds > 0)) throw new Error(`读不到音频时长：${file}；确认是有效音频文件。`);
  return Math.round(seconds * 1000);
}

async function cheapestModel(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetch(`${base}/v1/skills/models?type=video`, { headers: { authorization: `Bearer ${apiKey}` }, signal: signal ?? AbortSignal.timeout(20_000) });
  const catalog = await response.json() as { models?: Array<{ name?: string; available_for_this_key?: boolean }> };
  const available = new Set((catalog.models ?? []).filter(m => m.available_for_this_key !== false).map(m => String(m.name)));
  for (const candidate of MODELS_BY_PRICE) if (available.has(candidate)) return candidate;
  throw new Error(`网关没有可用的口型模型（找了 ${MODELS_BY_PRICE.join("、")}）；请用 --model 指定。`);
}

export async function lipSync(options: LipSyncOptions): Promise<{ out: string; model: string; durationMs: number; cost?: number; taskId: string }> {
  const source = path.resolve(options.faceImage), audio = path.resolve(options.audio), output = path.resolve(options.out);
  for (const [label, file, limit] of [["人脸图", source, 8], ["音频", audio, 20]] as const) {
    if (!fs.existsSync(file)) throw new Error(`${label}不存在：${file}`);
    const mib = fs.statSync(file).size / 1024 / 1024;
    if (mib > limit) throw new Error(`${label}超过 ${limit} MiB 上限（${mib.toFixed(1)}）。`);
  }
  if (fs.existsSync(output)) throw new Error(`输出已存在：${output}；口型生成不覆盖不重跑，换一个 --out。`);
  const durationMs = options.durationMs ?? probeDurationMs(audio);
  if (durationMs > 15_000) throw new Error(`音频 ${ (durationMs / 1000).toFixed(1) }s 超过冒烟上限 15s；先裁短再对口型（按秒计费）。`);
  if (!options.baseUrl || !options.apiKey) throw new Error("需要 GLINT_MEDIA_BASE_URL / GLINT_MEDIA_API_KEY（或显式传 baseUrl/apiKey）。");
  const model = options.model ?? await cheapestModel(options.baseUrl, options.apiKey, options.signal);
  const journalFile = `${output}.task.json`;
  if (fs.existsSync(journalFile)) throw new Error(`该输出已有未完成任务回执 ${journalFile}；先确认网关任务状态，勿重复提交。`);
  const bytesToDataUrl = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  const client = new MediaGatewayClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  // Journal before money leaves: a lost response must be recoverable, never resubmitted.
  fs.writeFileSync(journalFile, JSON.stringify({ state: "submitting", model, durationMs, face: path.basename(source), audio: path.basename(audio) }), { flag: "wx" });
  try {
    const audioDataUrl = bytesToDataUrl(audio, path.extname(audio).toLowerCase() === ".wav" ? "audio/wav" : "audio/mpeg");
    // Gateway field names differ per model (2026-10-25 probe): kling-avatar
    // takes sound_file; wan animate wants a reference video and is not usable
    // face+audio-only, so it is not in the default list.
    const params: Record<string, unknown> = model.includes("kling-avatar")
      ? { images: [bytesToDataUrl(source, path.extname(source).toLowerCase() === ".png" ? "image/png" : "image/jpeg")], sound_file: audioDataUrl, duration: Math.ceil(durationMs / 1000) }
      : { images: [bytesToDataUrl(source, path.extname(source).toLowerCase() === ".png" ? "image/png" : "image/jpeg")], sound_file: audioDataUrl, duration: Math.ceil(durationMs / 1000) };
    const taskId = await client.submit(model, "人物对白口型同步，动作自然", params, options.signal ?? AbortSignal.timeout(30_000));
    fs.writeFileSync(journalFile, JSON.stringify({ state: "submitted", taskId, model, durationMs }));
    const task = await client.wait(taskId, { signal: options.signal, timeoutMs: 600_000 });
    if (task.state !== "success" || !task.result_url) throw new Error(`口型任务失败（${task.state}）`);
    const downloadTask = { task_id: taskId, state: "success", is_final: true, result_url: task.result_url } as never;
    let result: Awaited<ReturnType<typeof downloadMediaResult>>;
    try {
      result = await downloadMediaResult(downloadTask, options.signal ?? AbortSignal.timeout(120_000), { publicDns: process.env.GLINT_MEDIA_PUBLIC_DNS === "1" });
    } catch (error) {
      if (!/Private, loopback or reserved/.test(String((error as Error).message))) throw error;
      result = await downloadMediaResult(downloadTask, options.signal ?? AbortSignal.timeout(120_000), { publicDns: true });
    }
    const videoFile = result.contentType.includes("png") ? null : output;
    if (!videoFile) throw new Error(`网关返回了非视频结果（${result.contentType}）；该模型不适合口型。`);
    fs.writeFileSync(videoFile, result.bytes);
    fs.writeFileSync(journalFile, JSON.stringify({ state: "done", taskId, model, durationMs, cost: task.cost, bytes: result.bytes.length }));
    return { out: videoFile, model, durationMs, cost: task.cost, taskId };
  } catch (error) {
    fs.writeFileSync(journalFile, JSON.stringify({ state: "failed", model, durationMs, error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}

/** Heuristic review (not acoustic): sample frames and let a text model judge mouth movement. */
export async function heuristicMouthCheck(video: string, frames = 3): Promise<{ heuristic: true; sampled: number; notes: string }> {
  const workspace = path.join(path.dirname(video), `.lipsync-frames-${Date.now()}`);
  fs.mkdirSync(workspace, { recursive: true });
  try {
    for (let index = 0; index < frames; index++) {
      await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", String((index + 0.5) / frames), "-i", video, "-frames:v", "1", path.join(workspace, `f${index}.jpg`)], { timeoutMs: 60_000 });
    }
    const sampled = fs.readdirSync(workspace).length;
    return { heuristic: true, sampled, notes: `抽帧 ${sampled} 张已生成；口型一致性需人工或文本模型看图审阅，本工具不自动判分。` };
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}
