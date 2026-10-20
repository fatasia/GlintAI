import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCliRuntime } from "./glint-runtime";
import { spawnSync } from "node:child_process";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-batch-check-"));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const project = path.join(out, "title.json");
fs.writeFileSync(
  project,
  JSON.stringify({
    schemaVersion: 1,
    id: "batch-first",
    title: "Batch",
    aspect: "16:9",
    fps: 24,
    knowledgeSources: [],
    scenes: [
      {
        kind: "title",
        id: "title",
        title: "共享渲染会话",
        narration: { text: "第一项", durationMs: 500 },
      },
    ],
  }),
);
const manifest = path.join(out, "batch.json");
fs.writeFileSync(
  manifest,
  JSON.stringify([
    {
      id: "first",
      args: [
        `--project=${project}`,
        "--format=png",
        `--out=${path.join(out, "first.png")}`,
      ],
    },
    {
      id: "second",
      args: [
        `--project=${path.join(repo, "examples/local-media/readiness.scenescript.json")}`,
        "--tts=mock",
        "--music=off",
        "--fast",
        `--out=${path.join(out, "second.mp4")}`,
      ],
    },
  ]),
);
const runtime = createCliRuntime(new URL("./glint.ts", import.meta.url).href);
const result = spawnSync(
  process.execPath,
  runtime.scriptArgs("render-worker", [`--batch=${manifest}`]),
  {
    cwd: runtime.studioDir,
    windowsHide: true,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
fs.writeFileSync(path.join(out, "worker.log"), result.stdout + result.stderr);
assert.equal(result.status, 0, result.stderr);
const replies = result.stdout
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
assert.equal(replies.length, 2);
assert(replies.every((reply) => reply.status === "done"));
assert.deepEqual(replies[1].stats, { bundles: 1, browsers: 1, jobs: 2 });
assert(fs.statSync(path.join(out, "first.png")).size > 1000);
assert(fs.statSync(path.join(out, "second.mp4")).size > 1000);
fs.writeFileSync(
  path.join(out, "report.json"),
  JSON.stringify({ status: "passed", output: out, replies }, null, 2),
);
console.log(`[batch] two real jobs, bundles=1, browsers=1 asserted: ${out}`);
