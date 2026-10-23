import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { captureProcess } from "./frame-diff";

/**
 * Opt-in long-form gate: 15 scenes / 60 seconds must render as one file with
 * every scene present. Run with GLINT_LONG_E2E=1.
 */
const studio = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-long-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it.skipIf(process.env.GLINT_LONG_E2E !== "1")("renders a 60-second multi-scene project as one continuous file", async () => {
  const project = path.join(root, "project.json"), output = path.join(root, "long.mp4");
  fs.writeFileSync(project, JSON.stringify({
    schemaVersion: 1, id: "long-form", title: "长视频压测", aspect: "16:9", theme: "mint-clean", knowledgeSources: [],
    scenes: Array.from({ length: 15 }, (_, index) => ({
      id: `scene-${index + 1}`, kind: "title", title: `第 ${index + 1} 段`,
      narration: { text: `第 ${index + 1} 段内容`, durationMs: 4000 },
    })),
  }));
  const requireStudio = createRequire(path.join(studio, "package.json"));
  const started = Date.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(requireStudio.resolve("tsx")).href, path.join(studio, "scripts", "glint.ts"),
      "render-native", `--project=${project}`, `--out=${output}`, "--resolution=720", "--no-cache"], { cwd: studio, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Long render exceeded the 600s budget")); }, 600_000);
    child.once("error", reject);
    child.once("close", value => { clearTimeout(timer); resolve(value); });
  });
  const elapsed = Date.now() - started;
  expect(code, "render-native exit code").toBe(0);
  const probe = JSON.parse((await captureProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,duration", "-of", "json", output], { timeoutMs: 30_000 })).toString("utf8"));
  expect(probe.streams[0]).toMatchObject({ width: 1280, height: 720 });
  expect(Number(probe.streams[0].nb_frames ?? 0)).toBeGreaterThanOrEqual(1750);
  expect(Number(probe.streams[0].duration)).toBeGreaterThanOrEqual(59);
  expect(Number(probe.streams[0].duration)).toBeLessThanOrEqual(61);
  console.log(`[long] 15 scenes / 60s @720p cold render: ${(elapsed / 1000).toFixed(1)}s`);
}, 620_000);
