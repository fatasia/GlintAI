import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync } from "node:zlib";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".vite/manifest.json"), "utf8"));
for (const entry of Object.values(manifest)) {
  if (!entry.file.endsWith(".js")) continue;
  const file = path.join(root, entry.file), bytes = fs.readFileSync(file);
  // The build deliberately leaves sub-1KB chunks uncompressed (compression
  // overhead can exceed the bytes saved). Still verify every emitted sidecar.
  if (bytes.length >= 1024 || fs.existsSync(`${file}.br`)) assert.deepEqual(brotliDecompressSync(fs.readFileSync(`${file}.br`)), bytes, `Brotli mismatch: ${entry.file}`);
  if (bytes.length >= 1024 || fs.existsSync(`${file}.gz`)) assert.deepEqual(gunzipSync(fs.readFileSync(`${file}.gz`)), bytes, `gzip mismatch: ${entry.file}`);
}
const seen = new Set();
function visit(key) {
  if (seen.has(key)) return;
  seen.add(key);
  for (const child of manifest[key]?.imports ?? []) visit(child);
}
for (const [key, entry] of Object.entries(manifest)) if (entry.isEntry) visit(key);
const files = [...seen].map(key => {
  const entry = manifest[key], bytes = fs.readFileSync(path.join(root, entry.file));
  return { file: entry.file, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, brotliBytes: brotliCompressSync(bytes).length };
});
const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
const report = { generatedAt: new Date().toISOString(), initial: files, gzipBytes, budgetBytes: 160 * 1024, passed: gzipBytes <= 160 * 1024, scope: "Static dependency graph only; preview/Three loaded on intent; not a measured Core Web Vitals score" };
console.log(JSON.stringify(report, null, 2));
if (process.env.GLINT_BUDGET_OUT) fs.writeFileSync(process.env.GLINT_BUDGET_OUT, JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
