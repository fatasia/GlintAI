import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { captureProcess } from "./frame-diff";

/**
 * Opt-in performance gate: a short 4K native render must finish and decode.
 * Run with GLINT_PERF_E2E=1. It is not part of the default suite because it
 * renders real frames (minutes on slow machines).
 */
const studio = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-perf-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it.skipIf(process.env.GLINT_PERF_E2E !== "1")("renders a short 4K project, decodes it and stays under the time budget", async () => {
  const project = path.join(root, "project.json"), output = path.join(root, "out.mp4");
  fs.writeFileSync(project, JSON.stringify({
    schemaVersion: 1, id: "perf-4k", title: "4K 压测", aspect: "16:9", theme: "bold-poster", knowledgeSources: [],
    scenes: [1, 2].map(index => ({ id: `shot-${index}`, kind: "title", title: `第 ${index} 屏`, narration: { text: `第 ${index} 屏`, durationMs: 1500 } })),
  }));
  const requireStudio = createRequire(path.join(studio, "package.json"));
  const started = Date.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(requireStudio.resolve("tsx")).href, path.join(studio, "scripts", "glint.ts"),
      "render-native", `--project=${project}`, `--out=${output}`, "--resolution=2160", "--no-cache"], { cwd: studio, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("4K render exceeded the 300s budget")); }, 300_000);
    child.once("error", reject);
    child.once("close", value => { clearTimeout(timer); resolve(value); });
  });
  const elapsed = Date.now() - started;
  expect(code, "render-native exit code").toBe(0);
  expect(fs.statSync(output).size).toBeGreaterThan(20_000);
  const probe = JSON.parse((await captureProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "json", output], { timeoutMs: 30_000 })).toString("utf8"));
  expect(probe.streams[0]).toMatchObject({ width: 3840, height: 2160 });
  expect(Number(probe.streams[0].nb_frames ?? 0)).toBeGreaterThanOrEqual(80);
  console.log(`[perf] 4K 2-scene render: ${(elapsed / 1000).toFixed(1)}s`);
}, 330_000);
