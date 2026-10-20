import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QwenLocalTtsProvider, synthesizeBatch } from "@glintai/tts";
import { createCliRuntime, readArg } from "./glint-runtime";
const args = process.argv.slice(2), studio = fileURLToPath(new URL("../", import.meta.url));
const modelDir = readArg(args, "model"), referenceAudio = readArg(args, "reference"), python = readArg(args, "python") ?? "python";
assert(modelDir && referenceAudio, "Pass --model=<local directory> --reference=<local audio> and optionally --python=<executable>");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clone-check-"));
const config = { python, modelDir: path.resolve(modelDir), referenceAudio: path.resolve(referenceAudio), referenceText: readArg(args, "reference-text") };
const report: Record<string, unknown> = { status: "running", output: out, provider: "Qwen3-TTS local", referenceMode: config.referenceText ? "audio-and-transcript" : "x-vector-only", subjectiveSimilarity: "not measured" };
const provider = new QwenLocalTtsProvider(config);
const text = "清晰的讲解，从一个具体问题开始。";
const cacheDir = path.join(studio, ".cache", "tts");
try {
  const start = performance.now();
  const [first] = await synthesizeBatch(provider, [{ text }], { concurrency: 1, cacheDir }); assert(first);
  report.firstCallMs = performance.now() - start;
  provider.dispose();
  const secondProvider = new QwenLocalTtsProvider(config), warm = performance.now();
  let second;
  try { [second] = await synthesizeBatch(secondProvider, [{ text }], { cacheDir }); }
  finally { secondProvider.dispose(); }
  report.cacheReadMs = performance.now() - warm;
  assert(second); assert.deepEqual(second.audio, first.audio);
  assert(first.durationMs > 100);
  assert(first.audio.subarray(128).some((sample) => sample !== 0), "Silent output");
  fs.writeFileSync(path.join(out, "cloned-speech.wav"), first.audio);
  report.durationMs = first.durationMs; report.audioBytes = first.audio.length;
  const project = { schemaVersion: 1, id: "local-clone-check", title: "本地克隆配音", language: "zh-CN", aspect: "16:9", fps: 24, theme: "cream-editorial", knowledgeSources: [], scenes: [{ id: "intro", kind: "title", title: "从一个问题开始", subtitle: "本地 Qwen 参考音频测试", narration: { text } }] };
  const file = path.join(out, "project.json"); fs.writeFileSync(file, JSON.stringify(project));
  const video = path.join(out, "cloned-draft.mp4"), runtime = createCliRuntime(new URL("./glint.ts", import.meta.url).href);
  await runtime.runScript("render", [`--project=${file}`, "--tts=qwen", `--tts-python=${config.python}`, `--tts-model=${config.modelDir}`, `--reference-audio=${config.referenceAudio}`, ...(config.referenceText ? [`--reference-text=${config.referenceText}`] : []), "--tts-concurrency=1", "--fast", "--music=off", `--out=${video}`]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", video], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr); report.video = JSON.parse(probe.stdout); report.videoBytes = fs.statSync(video).size;
  if(args.includes("--extended")) {
    const measured=new QwenLocalTtsProvider({...config,measureQuality:true,timeoutMs:600_000});
    const samples=["一个具体的问题，比十个抽象的名词更容易让人理解。", "我们先从一个简单的例子开始。假设你需要向同事解释一项新技术，不要急着罗列所有术语。先说清楚它解决什么问题，再展示一个可以重复的操作。接着比较使用前后的结果，说明变化从哪里来。最后补充适用条件和失败情况，让听众知道什么时候应该采用它，什么时候需要换一种方法。清晰的讲解，不是把内容变少，而是让每一步都有依据。", "A clear explanation starts with a concrete question. Show one example, explain the result, and describe the limits. Then ask your listener to explain the idea in their own words."];
    const results=[];
    try { for(const [index,text] of samples.entries()) { const start=performance.now(),result=await measured.synthesize({text,timeoutMs:600_000});fs.writeFileSync(path.join(out,`sample-${index}.wav`),result.audio);results.push({text,durationMs:result.durationMs,elapsedMs:performance.now()-start,...result.diagnostics}); } }
    finally { measured.dispose(); }
    report.extended={samples:results,metric:"Qwen speaker-encoder cosine; diagnostic proxy, not independent identity or perceptual quality assessment"};
  }
  report.status = "passed";
  console.log(`[voice] local model audio, content cache and MP4 passed; listen to the output before judging similarity: ${out}`);
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally { provider.dispose(); fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2)); }
