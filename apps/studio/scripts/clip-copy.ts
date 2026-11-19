import fs from "node:fs";
import path from "node:path";
import { llmFromEnvironment, type LlmProvider } from "@glintai/llm";

/**
 * S06 copy step: fill a clips.json manifest (from `glint clip`) with per-clip
 * platform copy — title, hook and caption — via the configured text model.
 * The model sees clip metadata only (timecodes, motion, neighbour titles);
 * frames are NOT uploaded, so copy stays grounded in what we can verify.
 */

export interface ClipCopy { id: string; title: string; hook: string; caption: string }

const SYSTEM = [
  "你是短视频运营文案。输入是一条从长片切出的短片信息（时间码、时长、运动评分、相邻片段标题）。",
  "为它产出中文平台文案 JSON：{\"clips\":[{\"id\":\"…\",\"title\":\"≤20字，具体不空泛\",\"hook\":\"≤25字，开头一句话钩子\",\"caption\":\"≤60字，平台简介含一个具体信息点\"}]}。",
  "规则：只依据给出的信息，不编造画面里没有的事实；不使用「震惊」「必看」类标题党；输出必须是单个 JSON 对象。",
].join("\n");

export async function writeClipCopy(options: { manifestFile: string; signal?: AbortSignal; llm?: LlmProvider }): Promise<{ copies: ClipCopy[]; manifestFile: string }> {
  const manifestPath = path.resolve(options.manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.length) throw new Error("清单里没有 clips；先运行 glint clip 生成切片。");
  const brief = (clips as Array<{ id: string; startMs: number; endMs: number; motionScore?: number | null; shotCount: number }>).map((clip, index) =>
    `${clip.id}：${(clip.startMs / 1000).toFixed(1)}s–${(clip.endMs / 1000).toFixed(1)}s，时长 ${(((clip.endMs ?? 0) - (clip.startMs ?? 0)) / 1000).toFixed(1)}s，镜头 ${clip.shotCount}，运动评分 ${clip.motionScore ?? "无法测量"}，${index === 0 ? "开场" : "第 " + (index + 1) + " 条"}`).join("\n");
  const llm = options.llm ?? llmFromEnvironment();
  const response = await llm.chat({ system: SYSTEM, messages: [{ role: "user", content: brief }], json: true, temperature: 0.6, timeoutMs: 120_000, signal: options.signal });
  const jsonText = response.text.slice(Math.max(0, response.text.indexOf("{")), response.text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonText) as { clips?: Array<{ id?: string; title?: string; hook?: string; caption?: string }> };
  if (!Array.isArray(parsed.clips)) throw new Error("模型没有返回 clips 数组；文案未写入。");
  const byId = new Map((clips as Array<{ id: string }>).map(clip => [clip.id, clip]));
  const copies: ClipCopy[] = [];
  for (const entry of parsed.clips) {
    const clip = byId.get(String(entry.id ?? ""));
    if (!clip || !entry.title?.trim()) continue;
    copies.push({ id: clip.id, title: entry.title.trim().slice(0, 40), hook: entry.hook?.trim().slice(0, 50) ?? "", caption: entry.caption?.trim().slice(0, 120) ?? "" });
  }
  if (!copies.length) throw new Error("模型返回与清单 id 不匹配；文案未写入。");
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, copy: copies }, null, 2));
  return { copies, manifestFile: manifestPath };
}
