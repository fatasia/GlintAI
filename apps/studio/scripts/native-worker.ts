import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePaths, readArg } from "./glint-runtime";
import { renderNative } from "./native-render";

export interface NativeWorkerRequest { id: string; args: string[] }
export function parseWorkerRequest(value: unknown, seen: Set<string>): NativeWorkerRequest {
  const request = value as NativeWorkerRequest;
  if (!request || typeof request.id !== "string" || !/^[\w-]{1,80}$/.test(request.id) || seen.has(request.id) || !Array.isArray(request.args) || request.args.length > 40 || request.args.some(arg => typeof arg !== "string" || arg.length > 12000)) throw new Error("Invalid or duplicate native render request");
  if (request.args.some(arg => /api.?key|authorization|bearer/i.test(arg))) throw new Error("Credentials belong in environment variables, never worker messages");
  seen.add(request.id);
  return request;
}

export async function serveNativeWorker(input: AsyncIterable<string | Buffer>, baseDir: string) {
  const seen = new Set<string>(); let buffer = "", stopped = false;
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const run = async (line: string) => {
    const raw = JSON.parse(line);
    if (raw?.type === "shutdown") { stopped = true; return; }
    if (seen.size >= 1000) throw new Error("Native worker request limit reached; restart worker");
    const request = parseWorkerRequest(raw, seen);
    const args = resolvePaths(request.args, baseDir), projectPath = readArg(args, "project"), output = readArg(args, "out");
    try {
      if (!projectPath || !output) throw new Error("Worker requests require --project and --out");
      const result = await renderNative({ projectPath, output, fast: args.includes("--fast"), plate: args.includes("--plate"), tts: readArg(args, "tts"), music: readArg(args, "music"), scenes: readArg(args, "scenes")?.split(","), noCache: args.includes("--no-cache") });
      emit({ id: request.id, status: "done", ...result });
    } catch (error) {
      emit({ id: request.id, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };
  for await (const chunk of input) {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error("Worker request exceeds 64 KiB");
      if (line.trim()) await run(line);
      if (stopped) return;
    }
    if (Buffer.byteLength(buffer) > 64 * 1024) throw new Error("Worker request exceeds 64 KiB");
  }
  if (buffer.trim()) await run(buffer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log = (...values) => process.stderr.write(values.join(" ") + "\n");
  process.stdin.setEncoding("utf8");
  serveNativeWorker(process.stdin, process.env.INIT_CWD || process.cwd()).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
