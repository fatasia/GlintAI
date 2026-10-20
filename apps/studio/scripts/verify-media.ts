import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mediaSourceAdapters, readSourceText } from "@glintai/knowledge";
import { readArg } from "./glint-runtime";
const args = process.argv.slice(2),
  python = readArg(args, "python"),
  modelDir = readArg(args, "model"),
  suiteFile = readArg(args, "suite");
assert(
  python && modelDir && suiteFile,
  "Pass --python= --model= --suite=<local JSON>",
);
assert(fs.statSync(suiteFile).size < 1024 * 1024, "Suite too large");
const suite = JSON.parse(fs.readFileSync(suiteFile, "utf8"));
assert(
  Array.isArray(suite.images) &&
    Array.isArray(suite.audio) &&
    suite.images.length + suite.audio.length <= 20,
);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-check-"));
const report: {
  status: string;
  output: string;
  images: unknown[];
  audio: unknown[];
  error?: string;
} = { status: "running", output: out, images: [], audio: [] };
const adapters = mediaSourceAdapters({ python, modelDir });
function distance(a: string[], b: string[]) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++)
      row.push(
        Math.min(
          prev[j + 1]! + 1,
          row[j]! + 1,
          prev[j]! + Number(a[i] !== b[j]),
        ),
      );
    prev = row;
  }
  return prev[b.length]!;
}
try {
  for (const [i, item] of suite.images.entries()) {
    const start = performance.now(),
      text = await readSourceText(
        { path: item.file },
        { adapters, timeoutMs: 120_000 },
      );
    assert(text.trim());
    if (item.contains) assert(text.includes(item.contains));
    fs.writeFileSync(path.join(out, `ocr-${i}.md`), text);
    report.images.push({
      file: item.file,
      text,
      elapsedMs: performance.now() - start,
    });
  }
  for (const [i, item] of suite.audio.entries()) {
    const start = performance.now(),
      text = await readSourceText(
        { path: item.file },
        { adapters, timeoutMs: 120_000 },
      );
    assert(text.trim());
    fs.writeFileSync(path.join(out, `transcript-${i}.md`), text);
    const clean = (s: string) =>
      s
        .replace(/\[[\d.]+–[\d.]+\]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .trim();
    const tokens = (s: string) =>
      item.language === "zh"
        ? Array.from(clean(s).replace(/\s/g, ""))
        : clean(s).split(/\s+/);
    const expected = tokens(item.text),
      actual = tokens(text),
      edits = distance(expected, actual);
    report.audio.push({
      file: item.file,
      expected: item.text,
      text,
      elapsedMs: performance.now() - start,
      metric: item.language === "zh" ? "CER" : "WER",
      edits,
      referenceTokens: expected.length,
      errorRate: edits / Math.max(1, expected.length),
      scope:
        "Whisper tiny local recognition of synthetic examples; not a domain accuracy guarantee",
    });
  }
  report.status = "passed";
  console.log(`[media] actual OCR/transcription suite completed: ${out}`);
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  throw e;
} finally {
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
