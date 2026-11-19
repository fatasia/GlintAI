import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildProject, planProject } from "./build";
import { renderNative } from "./native-render";
import { proveProject } from "./prove";

function amplitudeOfWav(file: string): number {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 4_000_000 });
  expect(result.status).toBe(0);
  const bytes = result.stdout; let sum = 0;
  for (let i = 0; i + 3 < bytes.length; i += 4) sum += bytes.readFloatLE(i) ** 2;
  return Math.sqrt(sum / (bytes.length / 4));
}

it("keeps CLI plans read-only and uses cached real TTS timing without duplicate calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-tts-budget-"));
  const cache = path.join(root, "cache"), voice = path.join(root, "voice.wav");
  const fixture = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1500:duration=1:sample_rate=44100", "-y", voice], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  let calls = 0, shouldFail = false;
  const server = createServer((req, res) => { calls++; req.resume(); req.on("end", () => { if (shouldFail) { res.writeHead(503); res.end("unavailable"); } else { res.writeHead(200, { "content-type": "audio/wav" }); res.end(fs.readFileSync(voice)); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local server unavailable");
  const project = path.join(root, "project.json");
  fs.writeFileSync(project, JSON.stringify({ schemaVersion: 1, id: "tts-budget", title: "TTS", aspect: "16:9", fps: 10, knowledgeSources: [], scenes: [{ id: "a", kind: "title", title: "TTS", narration: { text: "local voice", voice: "alloy", durationMs: 3000 } }] }));
  const require = createRequire(import.meta.url), cli = path.join(import.meta.dirname, "glint.ts"), loader = pathToFileURL(require.resolve("tsx")).href;
  const env = { ...process.env, INIT_CWD: root, GLINT_CACHE_DIR: cache, GLINT_TTS_BASE_URL: `http://127.0.0.1:${address.port}`, GLINT_TTS_MODEL: "local", GLINT_TTS_API_KEY: "test", TEMP: root, TMP: root };
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, cli, ...args], { cwd: root, env, windowsHide: true });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
  });
  const flags = [`--project=${project}`, "--tts=openai", "--music=off", "--fast", "--resolution=540"];
  try {
    shouldFail = true;
    const failedPath = path.join(root, "failed.mp4");
    const failed = await run(["build", ...flags, `--out=${failedPath}`]);
    expect(failed.code).not.toBe(0); expect(calls).toBe(1); expect(fs.existsSync(failedPath)).toBe(false);
    const failedAgain = await run(["build", ...flags, `--out=${failedPath}`]);
    expect(failedAgain.code).not.toBe(0); expect(calls).toBe(2);
    const failures = fs.readdirSync(root).filter(name => name.startsWith("failed.mp4.failure.") && name.endsWith(".receipt.json"));
    expect(failures).toHaveLength(2);
    for (const file of failures) {
      const failure = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      expect(failure).toMatchObject({ status: "failed", providerCalls: 1, costCny: null });
      expect(file).toContain(failure.attemptId); expect(failure).not.toHaveProperty("apiKey");
    }
    expect(failures.some(file => failed.output.includes(file))).toBe(true);
    expect(failures.some(file => failedAgain.output.includes(file))).toBe(true);
    const savedFailure = fs.readFileSync(path.join(root, failures[0]!), "utf8");
    expect(failed.output).not.toContain("Bearer test");
    const failedAgainReceipt = failures.find(file => failedAgain.output.includes(file));
    expect(failedAgainReceipt).toBeDefined();
    expect(fs.readFileSync(path.join(root, failures[0]!), "utf8")).toBe(savedFailure);
    shouldFail = false; calls = 0;
    const before = await run(["plan", "--budget", ...flags, `--out=${path.join(root, "plan.json")}`]); expect(before.code, before.output).toBe(0); expect(before.output).toContain("exact=false"); expect(calls).toBe(0);
    const coldPlan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8")); expect(coldPlan.modelCalls).toBeNull(); expect(coldPlan.plan.costCny).toBeNull();
    const denied = await run(["build", ...flags, `--out=${path.join(root, "denied.mp4")}`, "--assert-budget"]);
    expect(denied.code).not.toBe(0); expect(denied.output).toContain("Budget cannot be asserted before rendering"); expect(calls).toBe(0); expect(fs.existsSync(path.join(root, "denied.mp4"))).toBe(false);
    const first = await run(["build", ...flags, `--out=${path.join(root, "first.mp4")}`]); expect(first.code, first.output).toBe(0); expect(calls).toBe(1);
    const firstReceipt = JSON.parse(fs.readFileSync(path.join(root, "first.mp4.receipt.json"), "utf8"));
    expect(firstReceipt.totals.modelCalls).toBe(1); expect(firstReceipt.totals.costCny).toBeNull(); expect(firstReceipt.plan.matches).toBe(false);
    expect(firstReceipt.verification.find((entry: { law: string }) => entry.law === "L1").detail).toContain("not verified");
    expect(firstReceipt.nodes.find((node: { id: string }) => node.id === "audio:mix").costCny).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(root, "first.mp4.project.json"), "utf8")).scenes[0].narration.durationMs).toBe(1000);
    expect(amplitudeOfWav(path.join(root, "first.mp4"))).toBeGreaterThan(0.01);
    const planned = await run(["plan", "--budget", `--project=${project}`]); expect(planned.code, planned.output).toBe(0); expect(planned.output).toContain("exact=true"); expect(calls).toBe(1);
    const second = await run(["build", `--project=${project}`, `--out=${path.join(root, "second.mp4")}`, "--assert-budget"]); expect(second.code, second.output).toBe(0); expect(calls).toBe(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "second.mp4.receipt.json"), "utf8"));
    expect(receipt.plan.matches).toBe(true); expect(receipt.plan.actual).not.toContain("scene:a");
    expect(receipt.totals.modelCalls).toBe(0); expect(receipt.totals.costCny).toBe(0);
    const cacheFile = path.join(cache, "tts", fs.readdirSync(path.join(cache, "tts"))[0]!);
    const original = fs.readFileSync(cacheFile, "utf8"), savedCache = JSON.parse(original);
    for (const altered of [
      { ...savedCache, result: { ...savedCache.result, durationMs: 3000 } },
      { ...savedCache, result: { ...savedCache.result, words: [{ ...savedCache.result.words[0], startMs: 1 }] } },
      { ...savedCache, version: undefined, hash: "legacy" },
    ]) {
      fs.writeFileSync(cacheFile, JSON.stringify(altered));
      const badPlan = await run(["plan", "--budget", `--project=${project}`]);
      expect(badPlan.output).toContain("exact=false");
      const badBuild = await run(["build", `--project=${project}`, `--out=${path.join(root, "tampered.mp4")}`, "--assert-budget"]);
      expect(badBuild.code).not.toBe(0); expect(calls).toBe(1); expect(fs.existsSync(path.join(root, "tampered.mp4"))).toBe(false);
    }
    fs.writeFileSync(cacheFile, original);
    const changedVoice = await run(["plan", "--budget", `--project=${project}`, "--set=scenes[0].narration.voice=other"]);
    expect(changedVoice.code, changedVoice.output).toBe(0); expect(changedVoice.output).toContain("exact=false"); expect(calls).toBe(1);
    const guardedChange = await run(["build", `--project=${project}`, `--out=${path.join(root, "changed-voice.mp4")}`, "--set=scenes[0].narration.voice=other", "--assert-budget"]);
    expect(guardedChange.code).not.toBe(0); expect(calls).toBe(1); expect(fs.existsSync(path.join(root, "changed-voice.mp4"))).toBe(false);
    const mismatchEnv = ["GLINT_CACHE_DIR", "GLINT_TTS_BASE_URL", "GLINT_TTS_MODEL", "GLINT_TTS_API_KEY"] as const;
    const saved = Object.fromEntries(mismatchEnv.map(key => [key, process.env[key]]));
    try {
      for (const key of mismatchEnv) process.env[key] = env[key];
      const testsPath = path.join(root, "proof.json"); fs.writeFileSync(testsPath, JSON.stringify({ assert: [{ change: { maxCostCny: 0, maxModelCalls: 0 } }] }));
      const proof = proveProject({ projectPath: project, testsPath, tts: "openai" });
      expect(proof.pass).toBe(false); expect(proof.results[0]!.detail).toMatch(/unknown/);
      await expect(renderNative({ projectPath: project, output: path.join(root, "race.mp4"), tts: "openai", music: "off", fast: true, ttsCacheOnly: true, expectedNarrationSignature: "stale-signature" })).rejects.toThrow(/TTS timing changed/);
      expect(calls).toBe(1); expect(fs.existsSync(path.join(root, "race.mp4"))).toBe(false);
    } finally { for (const key of mismatchEnv) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
    const guarded = await run(["build", `--project=${project}`, `--out=${path.join(root, "no-tts.mp4")}`, "--no-cache", "--assert-budget"]);
    expect(guarded.code).not.toBe(0); expect(calls).toBe(1); expect(fs.existsSync(path.join(root, "no-tts.mp4"))).toBe(false);
    const fresh = await run(["build", `--project=${project}`, `--out=${path.join(root, "fresh.mp4")}`, "--no-cache"]); expect(fresh.code, fresh.output).toBe(0); expect(calls).toBe(2);
    const freshMetrics = JSON.parse(fs.readFileSync(path.join(root, "fresh.mp4.metrics.json"), "utf8")); expect(freshMetrics.cacheHits).toBe(0); expect(freshMetrics.containerHit).toBe(false);
    const noCacheMock = await run(["build", `--project=${project}`, `--out=${path.join(root, "mock-fresh.mp4")}`, "--tts=mock", "--no-cache", "--assert-budget"]);
    expect(noCacheMock.code, noCacheMock.output).toBe(0); expect(calls).toBe(2);
    const mockMetrics = JSON.parse(fs.readFileSync(path.join(root, "mock-fresh.mp4.metrics.json"), "utf8"));
    const mockReceipt = JSON.parse(fs.readFileSync(path.join(root, "mock-fresh.mp4.receipt.json"), "utf8"));
    expect(mockMetrics.cacheHits).toBe(0); expect(mockMetrics.containerHit).toBe(false); expect(mockReceipt.plan.actual).toContain("scene:a");
    const unknown = path.join(root, "unknown.json");
    fs.writeFileSync(unknown, JSON.stringify({ schemaVersion: 1, id: "unknown", title: "Unknown", aspect: "16:9", fps: 10, knowledgeSources: [], scenes: [{ id: "a", kind: "title", title: "Unknown", narration: { text: "unknown" } }] }));
    const missingDuration = await run(["build", `--project=${unknown}`, `--out=${path.join(root, "unknown.mp4")}`, "--tts=mock", "--music=off", "--assert-budget"]);
    expect(missingDuration.code).not.toBe(0); expect(missingDuration.output).toContain("Budget cannot be asserted before rendering"); expect(fs.existsSync(path.join(root, "unknown.mp4"))).toBe(false); expect(calls).toBe(2);
    const entries = fs.readdirSync(path.join(cache, "tts")); expect(entries.length).toBe(1);
    fs.writeFileSync(path.join(cache, "tts", entries[0]!), "corrupt");
    const bad = await run(["plan", "--budget", `--project=${project}`, "--tts=openai"]); expect(bad.output).toContain("exact=false"); expect(calls).toBe(2);
    const missing = await run(["build", `--project=${project}`, `--out=${path.join(root, "corrupt.mp4")}`, "--tts=openai", "--assert-budget"]); expect(missing.code).not.toBe(0); expect(calls).toBe(2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000);

it("buildProject noCache predicts and executes every scene", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-build-nocache-")), previous = process.env.GLINT_CACHE_DIR;
  process.env.GLINT_CACHE_DIR = path.join(root, "cache");
  try {
    const project = path.join(root, "project.json");
    fs.writeFileSync(project, JSON.stringify({ schemaVersion: 1, id: "bypass", title: "Bypass", aspect: "16:9", fps: 10, knowledgeSources: [], scenes: [{ id: "a", kind: "title", title: "Bypass", narration: { text: "x", durationMs: 200 } }] }));
    const common = { projectPath: project, tts: "mock", music: "off", fast: true, resolution: "540", log: () => {} };
    await buildProject({ ...common, output: path.join(root, "first.mp4") });
    const plan = planProject({ ...common, noCache: true }); expect(plan.plan.predicted).toContain("scene:a");
    const fresh = await buildProject({ ...common, noCache: true, assertBudget: true, output: path.join(root, "fresh.mp4") });
    expect(fresh.budget.matches).toBe(true); expect(fresh.receipt.plan.actual).toContain("scene:a");
    const metrics = JSON.parse(fs.readFileSync(path.join(root, "fresh.mp4.metrics.json"), "utf8")); expect(metrics.cacheHits).toBe(0); expect(metrics.containerHit).toBe(false);
  } finally { if (previous === undefined) delete process.env.GLINT_CACHE_DIR; else process.env.GLINT_CACHE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
