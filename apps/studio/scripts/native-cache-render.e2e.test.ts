import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderNative } from "./native-render";
import { graphForProject, buildProject } from "./build";
import { recordCacheArtifact } from "./native-cache";
import { parseProject } from "@glintai/scenescript";
import { build } from "esbuild";
import { createRequire } from "node:module";

// Hosted Windows runners are far slower at spawning freshly copied ffmpeg
// binaries and at cold-starting the bundled CLI; scale budgets for
// GLINT_CI_SLOW instead of weakening any cache/render assertion.
const slowScale = process.env.GLINT_CI_SLOW ? 3 : 1;

it("bypasses every render cache and distinguishes fast encoding at fixed resolution", async () => {
  expect(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status).toBe(0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-render-cache-isolated-"));
  const previous = process.env.GLINT_CACHE_DIR;
  process.env.GLINT_CACHE_DIR = path.join(root, "cache");
  try {
    const project = parseProject({ schemaVersion: 1, id: "cache-e2e", title: "Cache", aspect: "16:9", fps: 10, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Cache", narration: { text: "x", durationMs: 200 } }] });
    const projectPath = path.join(root, "project.json"); fs.writeFileSync(projectPath, JSON.stringify(project));
    const render = (name: string, fast: boolean, noCache = false) => renderNative({ projectPath, output: path.join(root, name), resolution: "540", fast, noCache, tts: "mock", music: "off", log: () => {} });
    const fast = await render("fast.mp4", true);
    const predicted = graphForProject(project, projectPath, { resolution: "540", fast: true });
    expect(predicted.sceneKeys["scene:one"]).toBe(fast.scenes[0]!.key);
    const container = path.join(root, "cache", "native-container");
    const artifacts = fs.readdirSync(container).filter(name => name.endsWith(".mp4"));
    expect(artifacts).toHaveLength(1);
    const poisoned = path.join(container, artifacts[0]!);
    fs.writeFileSync(poisoned, Buffer.alloc(100, 42)); recordCacheArtifact(poisoned);
    const bypass = await render("bypass.mp4", true, true);
    expect(bypass.metrics.cacheHits).toBe(0); expect(bypass.metrics.containerHit).toBe(false);
    expect(bypass.metrics.renderedFrames).toBeGreaterThan(0);
    expect(fs.statSync(bypass.output).size).toBeGreaterThan(100);
    expect(fs.statSync(poisoned).size).toBe(100);
    const high = await render("high.mp4", false);
    expect(high.scenes[0]!.key).not.toBe(fast.scenes[0]!.key);
    expect(high.metrics.cacheHits).toBe(0); expect(high.metrics.renderedFrames).toBeGreaterThan(0);
    expect(graphForProject(project, projectPath, { resolution: "540", fast: false }).sceneKeys["scene:one"]).toBe(high.scenes[0]!.key);
    const repeat = await render("high-repeat.mp4", false);
    expect(repeat.metrics.cacheHits).toBe(1); expect(repeat.metrics.containerHit).toBe(true);
    const music = (name: string, noCache: boolean) => renderNative({ projectPath, output: path.join(root, name), resolution: "540", fast: true, noCache, tts: "mock", music: "synth", log: () => {} });
    await music("music.mp4", false);
    const audioDir = path.join(root, "cache", "native-audio");
    const audioFiles = fs.readdirSync(audioDir).filter(name => name.endsWith(".wav"));
    expect(audioFiles).toHaveLength(1);
    const poisonedAudio = path.join(audioDir, audioFiles[0]!);
    fs.writeFileSync(poisonedAudio, Buffer.alloc(100, 99)); recordCacheArtifact(poisonedAudio);
    const fresh = await music("music-fresh.mp4", true);
    expect(fresh.metrics.containerHit).toBe(false);
    expect(fs.statSync(poisonedAudio).size).toBe(100);
    expect(spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", fresh.output], { encoding: "utf8" }).stdout.trim()).toBe("audio");
  } finally {
    if (previous === undefined) delete process.env.GLINT_CACHE_DIR; else process.env.GLINT_CACHE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000 * slowScale);

it("keeps build and render cache keys aligned for fractional rates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ntsc-cache-"));
  const previous = process.env.GLINT_CACHE_DIR; process.env.GLINT_CACHE_DIR = path.join(root, "cache");
  try {
    for (const fps of [23.976, 29.97, 59.94, 30]) {
      const project = parseProject({ schemaVersion: 1, id: `fps-${String(fps).replace(".", "-")}`, title: "Rate", aspect: "16:9", fps, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Rate", narration: { text: "x", durationMs: 200 } }] });
      const file = path.join(root, `project-${fps}.json`); fs.writeFileSync(file, JSON.stringify(project));
      const options = { projectPath: file, resolution: "540" as const, fast: true, tts: "mock", music: "off", log: () => {} };
      const predicted = graphForProject(project, file, options);
      const first = await renderNative({ ...options, output: path.join(root, `first-${fps}.mp4`) });
      expect(predicted.sceneKeys["scene:one"]).toBe(first.scenes[0]!.key);
      const actual = await buildProject({ ...options, output: path.join(root, `second-${fps}.mp4`) });
      expect(actual.budget.matches).toBe(true);
      expect(actual.receipt.plan.actual).not.toContain("scene:one");
    }
  } finally { if (previous === undefined) delete process.env.GLINT_CACHE_DIR; else process.env.GLINT_CACHE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000 * slowScale);

it("invalidates scene and container when ffmpeg bytes change in the same process", async () => {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  // Hosted Windows runners put a choco shim first in PATH; corrupting the shim breaks
  // its launcher chain with an EPIPE before the real ffmpeg is reached. Pick the
  // largest working candidate (the real binary) so appending marker bytes keeps it
  // runnable — PE loaders ignore trailing data, which is exactly the invalidation
  // this test exercises (Q-06c).
  const original = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .filter(line => spawnSync(line, ["-version"], { stdio: "ignore" }).status === 0)
    .map(line => ({ line, size: fs.statSync(line).size }))
    .sort((a, b) => b.size - a.size)[0]?.line;
  expect(original, "no working ffmpeg candidate found").toBeTruthy();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ffmpeg-cache-"));
  const previousPath = process.env.PATH, previousCache = process.env.GLINT_CACHE_DIR;
  try {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    const executable = path.join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    fs.copyFileSync(original!, executable); fs.chmodSync(executable, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.GLINT_CACHE_DIR = path.join(root, "cache");
    const project = { schemaVersion: 1, id: "ffmpeg-version", title: "Version", aspect: "16:9", fps: 10, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Version", narration: { text: "x", durationMs: 200 } }] };
    const file = path.join(root, "project.json"); fs.writeFileSync(file, JSON.stringify(project));
    const run = (name: string) => renderNative({ projectPath: file, output: path.join(root, name), resolution: "540", fast: true, tts: "mock", music: "off", log: () => {} });
    const first = await run("first.mp4");
    const firstClip = fs.readFileSync(path.join(root, "cache", "native-scenes", `${first.scenes[0]!.key}.mp4`));
    const unchanged = await run("unchanged.mp4"); expect(unchanged.metrics.containerHit).toBe(true);
    fs.appendFileSync(executable, Buffer.from("glint isolated test marker"));
    const changed = await run("changed.mp4");
    expect(changed.environment.ffmpeg).not.toBe(first.environment.ffmpeg);
    expect(changed.scenes[0]!.key).not.toBe(first.scenes[0]!.key);
    expect(fs.readFileSync(path.join(root, "cache", "native-scenes", `${changed.scenes[0]!.key}.mp4`))).toEqual(firstClip);
    expect(changed.metrics.cacheHits).toBe(0); expect(changed.metrics.renderedFrames).toBeGreaterThan(0);
    expect(changed.metrics.containerHit).toBe(false);
    const again = await run("again.mp4"); expect(again.metrics.containerHit).toBe(true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.GLINT_CACHE_DIR; else process.env.GLINT_CACHE_DIR = previousCache;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000 * slowScale);

it("reuses the NTSC scene cache in an isolated packaged CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-packaged-ntsc-"));
  try {
    const repo = path.resolve(import.meta.dirname, "../../..");
    const cliDir = path.join(root, "app", "cli"), studio = path.join(root, "app", "studio");
    fs.mkdirSync(cliDir, { recursive: true }); fs.mkdirSync(studio, { recursive: true });
    const entry = path.join(cliDir, "glint.mjs");
    const shim = 'import {createRequire as __r} from "node:module"; import {fileURLToPath as __f} from "node:url"; const require=__r(import.meta.url); const __filename=__f(import.meta.url); const __dirname=__filename.slice(0,Math.max(__filename.lastIndexOf("/"),__filename.lastIndexOf("\\\\")));';
    await build({ entryPoints: [path.join(repo, "apps/studio/scripts/glint.ts")], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", external: ["@resvg/resvg-js", "@remotion/bundler"], logLevel: "silent", banner: { js: shim } });
    const require = createRequire(path.join(repo, "apps/studio/package.json"));
    const resvg = path.dirname(require.resolve("@resvg/resvg-js/package.json"));
    const installed = path.join(root, "app", "node_modules", "@resvg"); fs.mkdirSync(installed, { recursive: true });
    fs.cpSync(resvg, path.join(installed, "resvg-js"), { recursive: true, dereference: true });
    const resvgRequire = createRequire(path.join(resvg, "package.json"));
    const binding = resvgRequire.resolve(`@resvg/resvg-js-${process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu"}/package.json`);
    fs.cpSync(path.dirname(binding), path.join(installed, path.basename(path.dirname(binding))), { recursive: true, dereference: true });
    const projectPath = path.join(root, "project.json");
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, id: "portable-ntsc", title: "Portable", aspect: "16:9", fps: 29.97, knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Portable", narration: { text: "x", durationMs: 200 } }] }));
    const env = { ...process.env, GLINT_STUDIO_DIR: studio, GLINT_CACHE_DIR: path.join(root, "cache"), GLINT_CLI_ENTRY: entry, INIT_CWD: root, TEMP: root, TMP: root };
    const run = (name: string, flags: string[] = []) => spawnSync(process.execPath, [entry, "build", `--project=${projectPath}`, `--out=${path.join(root, name)}`, ...flags, "--assert-budget"], { cwd: studio, env, encoding: "utf8", timeout: 120_000 * slowScale, windowsHide: true });
    const first = run("first.mp4", ["--fast", "--resolution=540", "--tts=mock", "--music=off"]); expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const second = run("second.mp4"); expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const metrics = JSON.parse(fs.readFileSync(path.join(root, "second.mp4.metrics.json"), "utf8"));
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "second.mp4.receipt.json"), "utf8"));
    expect(metrics.cacheHits).toBe(1); expect(receipt.plan.matches).toBe(true); expect(receipt.plan.actual).not.toContain("scene:one");
    expect(metrics.height).toBe(540);
    expect(receipt.recipe).toMatchObject({ fast: true, resolution: "540", tts: "mock", music: "off" });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".glint", "manifest.json"), "utf8"));
    expect(manifest.profile).toMatchObject({ fast: true, resolution: "540", tts: "mock", music: "off" });
    const third = run("third.mp4", ["--resolution=720", "--music=synth"]); expect(third.status, `${third.stdout}\n${third.stderr}`).toBe(0);
    const thirdMetrics = JSON.parse(fs.readFileSync(path.join(root, "third.mp4.metrics.json"), "utf8"));
    const thirdReceipt = JSON.parse(fs.readFileSync(path.join(root, "third.mp4.receipt.json"), "utf8"));
    const updated = JSON.parse(fs.readFileSync(path.join(root, ".glint", "manifest.json"), "utf8"));
    expect(thirdMetrics.height).toBe(720); expect(thirdReceipt.plan.matches).toBe(true);
    expect(thirdReceipt.recipe).toMatchObject({ fast: true, resolution: "720", tts: "mock", music: "synth" });
    expect(updated.profile).toMatchObject({ fast: true, resolution: "720", tts: "mock", music: "synth" });
    const fourth = run("fourth.mp4"); expect(fourth.status, `${fourth.stdout}\n${fourth.stderr}`).toBe(0);
    const fourthMetrics = JSON.parse(fs.readFileSync(path.join(root, "fourth.mp4.metrics.json"), "utf8"));
    const fourthReceipt = JSON.parse(fs.readFileSync(path.join(root, "fourth.mp4.receipt.json"), "utf8"));
    expect(fourthMetrics.height).toBe(720); expect(fourthMetrics.cacheHits).toBe(1);
    expect(fourthReceipt.plan.matches).toBe(true); expect(fourthReceipt.recipe.music).toBe("synth");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 180_000 * slowScale);
