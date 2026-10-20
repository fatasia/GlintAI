import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
/** Bound CPU/memory and terminate parsing on cancellation, including hostile PDFs. */
export function extractPdf(bytes: Buffer, signal: AbortSignal): Promise<string> {
  try { require.resolve("pdf-parse/lib/pdf-parse.js"); }
  catch { throw new Error("PDF adapter is not installed. Run pnpm install with optional dependencies enabled."); }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.cjs", import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(text!);
    };
    const abort = () => finish(new Error("PDF extraction cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: { text?: string; error?: string }) => {
      if (result.error) finish(new Error(`PDF extraction failed: ${result.error}`));
      else if (typeof result.text !== "string") finish(new Error("PDF worker returned invalid text"));
      else finish(undefined, result.text);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => finish(new Error(`PDF worker exited without text (${code})`)));
    if (signal.aborted) abort();
  });
}
