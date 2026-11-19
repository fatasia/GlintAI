import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Standard-library XLSX reader: bounded input/output, no macros or external relations. */
export async function readWorkbook(bytes, signal) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 2 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid XLSX");
  signal.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-workbook-"));
  const input = path.join(dir, "input.xlsx");
  try {
    await fs.writeFile(input, bytes, { flag: "wx" });
    const script = fileURLToPath(new URL("../../studio/scripts/read-workbook.py", import.meta.url));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.env.GLINT_TABLE_PYTHON || "python", ["-I", script, input], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const chunks = []; let size = 0, tooLarge = false, failure;
      const abort = () => child.kill(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      child.stdout.on("data", chunk => { size += chunk.length; if (size > 128 * 1024) { tooLarge = true; child.kill(); } else chunks.push(chunk); });
      child.once("error", error => { failure = error; });
      child.once("close", code => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(new Error("Workbook read cancelled")); else if (failure) reject(failure); else if (tooLarge) reject(new Error("Workbook output too large")); else if (code !== 0) reject(new Error("Workbook reader failed")); else resolve(Buffer.concat(chunks).toString("utf8")); });
    });
    const sheets = JSON.parse(output);
    if (!Array.isArray(sheets) || !sheets.length || sheets.length > 32 || sheets.some(sheet => !sheet || typeof sheet.name !== "string" || !sheet.name || sheet.name.length > 128 || typeof sheet.text !== "string" || !sheet.text.trim() || sheet.text.length > 12000)) throw new Error("Workbook contains no usable sheets or exceeds limits");
    return sheets;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
