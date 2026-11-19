import fs from "node:fs";
import path from "node:path";
import { llmFromEnvironment, type LlmProvider } from "@glintai/llm";
import { buildProjectCues, formatSrt, formatVtt, type CaptionCue } from "./jianying";
import { parseProject } from "@glintai/scenescript";
import type { SceneScriptProject } from "@glintai/scenescript";

/**
 * AUDIO-06 字幕翻译：工程字幕时间轴不动，只翻译文本。
 * 模型只看到逐条原文，返回逐条译文；条数与顺序由本地对账，模型无法增删。
 */

const SYSTEM = [
  "你是字幕翻译。输入是一个 JSON 数组，每项 {\"i\":序号,\"text\":\"原文\"}。",
  "输出同长度的 JSON 数组，每项 {\"i\":序号,\"text\":\"译文\"}；序号必须一一对应。",
  "规则：字幕要口语、按条独立成立、长度接近原文（同一语言时≤原文 1.5 倍）；专有名词保留；不合并、不拆分、不增删条目；输出单个 JSON 对象 {\"cues\":[…]}。",
].join("\n");

export interface TranslateResult { cues: CaptionCue[]; file: string }

export async function translateProjectSubtitles(options: {
  project: SceneScriptProject;
  lang: string;
  out?: string;
  format?: "srt" | "vtt";
  signal?: AbortSignal;
  llm?: LlmProvider;
}): Promise<TranslateResult> {
  const cues = buildProjectCues(options.project);
  if (!cues.length) throw new Error("工程没有可翻译的字幕文本。");
  const llm = options.llm ?? llmFromEnvironment();
  const translated = await translateCues(cues, options.lang, llm, options.signal);
  const base = options.out ?? path.join("out", `${options.project.id}.${options.lang}.srt`);
  const file = options.format === "vtt" ? base.replace(/\.srt$/, ".vtt") : base;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, options.format === "vtt" ? formatVtt(translated) : formatSrt(translated), "utf8");
  return { cues: translated, file };
}

export async function translateCues(cues: CaptionCue[], lang: string, llm: LlmProvider, signal?: AbortSignal): Promise<CaptionCue[]> {
  if (!lang.trim()) throw new Error("translate requires a target --lang=<语言>");
  // Long narrations exceed one request; chunk so a single failure costs one block, not the file.
  const CHUNK = 40;
  const out: CaptionCue[] = [];
  for (let offset = 0; offset < cues.length; offset += CHUNK) {
    const block = cues.slice(offset, offset + CHUNK);
    const payload = JSON.stringify({ lang, cues: block.map((cue, index) => ({ i: offset + index, text: cue.text })) });
    const response = await llm.chat({ system: SYSTEM, messages: [{ role: "user", content: payload }], json: true, temperature: 0.3, timeoutMs: 180_000, signal });
    const jsonText = response.text.slice(Math.max(0, response.text.indexOf("{")), response.text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonText) as { cues?: Array<{ i?: number; text?: string }> };
    if (!Array.isArray(parsed.cues)) throw new Error(`模型没有返回 cues 数组（第 ${offset}–${offset + block.length - 1} 条未翻译）。`);
    const seen = new Set<number>();
    for (const entry of parsed.cues) {
      const index = Number(entry.i);
      // A forged duplicate or out-of-block index means the reply cannot be trusted for this block.
      if (seen.has(index) || !(index >= offset && index < offset + block.length)) throw new Error(`模型返回的序号越界或重复（${index}），本块 ${offset}–${offset + block.length - 1} 未采信。`);
      seen.add(index);
    }
    for (let index = 0; index < block.length; index++) {
      const text = seen.has(offset + index) ? String(parsed.cues!.find(entry => Number(entry.i) === offset + index)?.text ?? "") : "";
      // A missing or empty translation keeps the original text rather than dropping the cue.
      out.push(text.trim() ? { ...block[index]!, text: text.trim() } : block[index]!);
    }
  }
  return out;
}
