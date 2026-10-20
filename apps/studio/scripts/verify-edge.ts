import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EdgeTtsProvider } from "@glintai/tts";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-edge-check-"));
const report: Record<string, unknown> = {
  status: "running",
  output: out,
  source: "Public original test sentence; Microsoft Edge TTS network service",
};
const provider = new EdgeTtsProvider();
try {
  const start = performance.now(),
    result = await provider.synthesize({
      text: "清晰的讲解，从一个具体问题开始。",
      timeoutMs: 30_000,
    });
  assert(result.audio.length > 1000);
  fs.writeFileSync(path.join(out, "speech.mp3"), result.audio);
  Object.assign(report, {
    status: "passed",
    elapsedMs: performance.now() - start,
    durationMs: result.durationMs,
    bytes: result.audio.length,
  });
  console.log(`[edge] actual remote synthesis: ${out}`);
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
  console.error(`[edge] ${report.error}`);
} finally {
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
