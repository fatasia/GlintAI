import fs from "node:fs";
import { RenderSession } from "./render-session";
import { renderOnce } from "./render";
import path from "node:path";
import { resolvePaths } from "./glint-runtime";
const session = new RenderSession();
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
console.log = (...values) => {
  process.stderr.write(values.join(" ") + "\n");
};
let count = 0;
const seen = new Set<string>();
async function run(
  value: unknown,
  baseDir = process.env.INIT_CWD || process.cwd(),
) {
  const request = value as { id?: unknown; args?: unknown; type?: unknown };
  if (request?.type === "shutdown") return false;
  if (
    !request ||
    typeof request.id !== "string" ||
    !/^[\w-]{1,80}$/.test(request.id) ||
    seen.has(request.id) ||
    !Array.isArray(request.args) ||
    request.args.length > 40 ||
    request.args.some((arg) => typeof arg !== "string" || arg.length > 12000) ||
    ++count > 1000
  )
    throw new Error("Invalid or duplicate render request");
  seen.add(request.id);
  try {
    const output = await renderOnce(
      resolvePaths(request.args, baseDir),
      session,
    );
    emit({ id: request.id, status: "done", output, stats: session.stats });
  } catch {
    emit({
      id: request.id,
      status: "error",
      error: "Render failed; see local stderr",
      stats: session.stats,
    });
    process.exitCode = 1;
  }
  return true;
}
try {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 1 || !args[0]?.startsWith("--batch="))
      throw new Error("Only --batch=<JSON manifest> is supported");
    const file = args[0].slice(8);
    if (fs.statSync(file).size > 1024 * 1024)
      throw new Error("Batch manifest exceeds 1 MiB");
    const batch = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(batch) || !batch.length || batch.length > 100)
      throw new Error("Batch requires 1..100 requests");
    for (const item of batch)
      if (!(await run(item, path.dirname(path.resolve(file))))) break;
  } else {
    process.stdin.setEncoding("utf8");
    let buffer = "",
      stopped = false;
    for await (const chunk of process.stdin) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 64 * 1024)
          throw new Error("Request exceeds 64 KiB");
        if (line.trim() && !(await run(JSON.parse(line)))) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      if (Buffer.byteLength(buffer) > 64 * 1024)
        throw new Error("Request exceeds 64 KiB");
    }
    if (!stopped && buffer.trim()) await run(JSON.parse(buffer));
  }
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
} finally {
  await session.dispose();
}
