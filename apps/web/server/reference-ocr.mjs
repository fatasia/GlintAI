import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./reference-ocr.py", import.meta.url));
const inputOptions = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,flv,ogg"];

/** Kills only the child created here, then waits for close before returning. */
function boundedProcess(command, args, { signal, maxBytes, timeoutMs, input, env }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"], env });
    let size = 0, failure, spawnError; const chunks = [];
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    const timer = setTimeout(() => { failure = new Error("OCR subprocess timed out"); stop(); }, timeoutMs);
    child.stdout.on("data", chunk => { size += chunk.length; if (size > maxBytes) { failure = new Error("OCR subprocess output exceeds limit"); stop(); } else chunks.push(chunk); });
    child.once("error", error => { spawnError = error; });
    child.stdin?.on("error", () => {});
    if (input) child.stdin.end(input);
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason ?? new Error("OCR cancelled"));
      else if (failure) reject(failure); else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error("OCR subprocess failed"));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** A bounded local frame sample shared by OCR and explicit reference-frame refresh. */
export async function captureReferenceFrame(source, at, signal) {
  const bytes = await boundedProcess("ffmpeg", ["-nostdin", "-v", "error", ...inputOptions, "-i", source, "-ss", String(at / 1000), "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"], { signal, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  if (!bytes.length) throw new Error("No sample frame");
  return bytes;
}

/** Explicit opt-in; frame bytes and OCR output never enter the project or logs. */
export async function runReferenceOcr({ source, report, signal, python = process.env.GLINT_REFERENCE_OCR_PYTHON, ocrScript = script }) {
  if (!python || !path.isAbsolute(python) || !fs.existsSync(python)) return { status: "unavailable", samples: [] };
  signal.throwIfAborted();
  const limited = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    const frames = [];
    for (const shot of report.shots.slice(0, 12)) {
      const at = Math.floor((shot.startMs + shot.endMs) / 2);
      const bytes = await captureReferenceFrame(source, at, limited);
      frames.push({ shot, at, bytes });
    }
    const payload = Buffer.from(JSON.stringify({ frames: frames.map(frame => frame.bytes.toString("base64")) }));
    if (payload.length > 16 * 1024 * 1024) throw new Error("OCR batch too large");
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const out = await boundedProcess(python, ["-I", "-X", "utf8", ocrScript], { signal: limited, maxBytes: 128 * 1024, timeoutMs: 90_000, input: payload, env });
    const data = JSON.parse(out.toString("utf8"));
    if (!Array.isArray(data.samples) || data.samples.length !== frames.length) throw new Error("Invalid OCR output");
    const samples = data.samples.map((sample, index) => {
      if (!sample || !Number.isInteger(sample.width) || !Number.isInteger(sample.height) || sample.width < 1 || sample.height < 1 || sample.width * sample.height > 2_000_000 || !Array.isArray(sample.lines) || sample.lines.length > 100) throw new Error("Invalid OCR sample");
      const lines = sample.lines.map(line => {
        if (!line || typeof line.text !== "string" || !line.text.trim() || line.text.length > 500 || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(line.text) || !Number.isFinite(line.score) || line.score < 0 || line.score > 1) throw new Error("Invalid OCR line");
        return { text: line.text, score: line.score };
      });
      const frame = frames[index];
      return { sceneId: frame.shot.id.replace(/^shot-/, "ref-shot-"), requestedMs: frame.at, width: sample.width, height: sample.height, status: lines.length ? "recognized" : "no_text", lines };
    });
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(source, { signal: limited })) hash.update(chunk);
    if (hash.digest("hex") !== report.source.sha256) throw Object.assign(new Error("Reference source changed during OCR"), { changedSource: true });
    return { status: "complete", sourceSha256: report.source.sha256, samples };
  } catch (error) {
    if (signal.aborted || error?.changedSource) throw error;
    return { status: "failed", samples: [] };
  }
}
