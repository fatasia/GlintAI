import fs from "node:fs/promises";
import path from "node:path";
import { serviceTarget, serviceJson, ServiceRequestError } from "./service-http";

const reads = ["config", "bindings", "status", "request", "receipt"];
const writes = ["bind", "quote", "approve", "submit", "cancel"];
function flags(args: string[]) {
  const result = new Map<string, string>();
  for (const item of args) {
    const match = /^--(endpoint|request|id)=(.+)$/.exec(item);
    if (!match || result.has(match[1]!)) throw new Error("invalid-argument");
    result.set(match[1]!, match[2]!);
  }
  return result;
}
async function inputFile(file: string, cwd: string) {
  const target = path.resolve(cwd, file),
    stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3 * 1024 * 1024)
    throw new Error("invalid-request-file");
  const handle = await fs.open(target, "r");
  try {
    const current = await handle.stat();
    if (current.ino !== stat.ino || current.size !== stat.size)
      throw new Error("request-file-changed");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 3 * 1024 * 1024) throw new Error("request-too-large");
    const input: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("invalid-request");
    if (/"(?:token|apiKey|authorization|password|secret)"\s*:/i.test(JSON.stringify(input)))
      throw new Error("credential-in-request");
    return input;
  } finally {
    await handle.close();
  }
}
/** Same authenticated HTTP service as Web. No provider key flags, retries or separate queue. */
export async function runMediaExecution(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
): Promise<number> {
  try {
    const action = args[0] ?? "";
    if (![...reads, ...writes].includes(action)) throw new Error("invalid-action");
    const options = flags(args.slice(1)),
      endpoint = options.get("endpoint") ?? env.GLINT_MEDIA_EXECUTION_ENDPOINT;
    if (!endpoint) throw new Error("endpoint-required");
    const id = options.get("id"),
      file = options.get("request"),
      identified = ["status", "request", "receipt", "cancel"].includes(action);
    if (
      identified
        ? !id || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || file
        : Boolean(id) || writes.includes(action) !== Boolean(file)
    )
      throw new Error("invalid-arguments");
    const route = action === "bind" ? "bindings" : action;
    const url = serviceTarget(
      endpoint,
      `/api/media/execution/${route}${identified ? `/${id}` : ""}`,
    );
    const body = file
      ? await inputFile(file, env.INIT_CWD || process.cwd())
      : action === "cancel"
        ? {}
        : undefined;
    const response = await serviceJson(
      url,
      { endpoint, token: env.GLINT_ACCESS_TOKEN, signal: AbortSignal.timeout(120000) },
      {
        method: writes.includes(action) ? "POST" : "GET",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      4 * 1024 * 1024,
    );
    if (!response.ok) throw new ServiceRequestError("http-refused", response.status);
    write(JSON.stringify(response.value));
    return 0;
  } catch (error) {
    const code =
      error instanceof ServiceRequestError
        ? error.code
        : error instanceof Error && /^[a-z-]+$/.test(error.message)
          ? error.message
          : "request-failed";
    write(JSON.stringify({ error: code, retryAutomatically: false }));
    return 2;
  }
}
