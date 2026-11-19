import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript module exercised with controlled local subprocesses.
import { runReferenceOcr } from "./reference-ocr.mjs";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("keeps OCR opt-in, bounds and attributes sampled text to the source and shot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ocr-test-"));
  try {
    const python = execFileSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
    const source = path.join(root, "video.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=2", "-c:v", "mpeg4", source]);
    const script = path.join(root, "fixture.py");
    fs.writeFileSync(script, 'import json,sys\nx=json.load(sys.stdin)\na=[{"width":1280,"height":720,"lines":[{"text":"示例","score":0.75}]} if i==0 else {"width":1280,"height":720,"lines":[]} for i,_ in enumerate(x["frames"])]\nprint(json.dumps({"samples":a},ensure_ascii=False))\n');
    const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const report = { source: { sha256: hash }, shots: [{ id: "shot-001", startMs: 0, endMs: 1000 }, { id: "shot-002", startMs: 1000, endMs: 2000 }] };
    const signal = new AbortController().signal;
    expect((await runReferenceOcr({ source, report, signal, python: "" })).status).toBe("unavailable");
    const out = await runReferenceOcr({ source, report, signal, python, ocrScript: script });
    expect(out.status).toBe("complete"); expect(out.sourceSha256).toBe(hash);
    expect(out.samples).toMatchObject([{ sceneId: "ref-shot-001", requestedMs: 500, status: "recognized", lines: [{ text: "示例", score: 0.75 }] }, { sceneId: "ref-shot-002", requestedMs: 1500, status: "no_text", lines: [] }]);
    await expect(runReferenceOcr({ source, report: { ...report, source: { sha256: "0".repeat(64) } }, signal, python, ocrScript: script })).rejects.toThrow(/changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 45000);

it("waits for the owned OCR child to close after cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ocr-cancel-"));
  try {
    const python = execFileSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim(), source = path.join(root, "video.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=1", "-c:v", "mpeg4", source]);
    const marker = path.join(root, "started"), script = path.join(root, "wait.py");
    fs.writeFileSync(script, `import json,sys,time\njson.load(sys.stdin)\nopen(${JSON.stringify(marker.replaceAll("\\", "/"))}, "w").close()\ntime.sleep(30)\n`);
    const controller = new AbortController(), promise = runReferenceOcr({ source, report: { source: { sha256: "0".repeat(64) }, shots: [{ id: "shot-001", startMs: 0, endMs: 1000 }] }, signal: controller.signal, python, ocrScript: script });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(50);
    expect(fs.existsSync(marker)).toBe(true);
    controller.abort(); await expect(promise).rejects.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
