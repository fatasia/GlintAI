import fs from "node:fs/promises";
import path from "node:path";
import { listContainers, containerRequest, ContainerRequestError, CONTAINER_REQUEST_LIMIT, type ContainerAction } from "./container-api-client";

function arg(args: string[], name: string): string | undefined { return args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3); }
async function readRequest(file: string, callerDir: string): Promise<Record<string, unknown>> {
  const handle = await fs.open(path.resolve(callerDir, file), "r");
  try {
    if (!(await handle.stat()).isFile()) throw new ContainerRequestError("request-not-file");
    const buffer = Buffer.alloc(CONTAINER_REQUEST_LIMIT + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break; size += bytesRead;
    }
    if (size > CONTAINER_REQUEST_LIMIT) throw new ContainerRequestError("request-too-large");
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContainerRequestError("invalid-object");
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}

/** JSON request files use the same fields as HTTP; credentials never come from flags. */
export async function runContainer(args: string[], env: NodeJS.ProcessEnv = process.env, write: (line: string) => void = console.log): Promise<number> {
  try {
    const action = args[0] as ContainerAction | "list";
    if (!["list", "snapshot", "open", "append", "undo", "redo", "lifecycle", "migrate-copy"].includes(action)) throw new ContainerRequestError("invalid-action");
    const allowed = new Set(action === "list" ? ["endpoint", "limit", "cursor"] : ["endpoint", "id", "request"]), seen = new Set<string>();
    for (const value of args.slice(1)) {
      const match = /^--([^=]+)=(.+)$/.exec(value);
      if (!match || !allowed.has(match[1]!) || seen.has(match[1]!)) throw new ContainerRequestError("invalid-argument");
      seen.add(match[1]!);
    }
    const endpoint = arg(args, "endpoint") ?? env.GLINT_CONTAINER_ENDPOINT;
    if (!endpoint) throw new ContainerRequestError("endpoint-required");
    if (action === "list") {
      const limit = arg(args, "limit");
      if (limit !== undefined && !/^[1-9][0-9]?$/.test(limit)) throw new ContainerRequestError("invalid-limit");
      write(JSON.stringify(await listContainers({ endpoint, token: env.GLINT_ACCESS_TOKEN, ...(limit === undefined ? {} : { limit: Number(limit) }), ...(arg(args, "cursor") === undefined ? {} : { cursor: arg(args, "cursor") }) }))); return 0;
    }
    const file = arg(args, "request"), id = arg(args, "id");
    if (action === "snapshot" ? (!id || file) : (!file || id)) throw new ContainerRequestError("request-required");
    const body = action === "snapshot" ? { projectId: id! } : await readRequest(file!, env.INIT_CWD || process.cwd());
    const result = await containerRequest(action, body, { endpoint, token: env.GLINT_ACCESS_TOKEN });
    write(JSON.stringify(result)); return 0;
  } catch (error) {
    const known = error instanceof ContainerRequestError ? error : new ContainerRequestError("invalid-request-file");
    write(JSON.stringify({ error: known.code, ...(known.status === undefined ? {} : { status: known.status }), ...(known.result ? { result: known.result } : {}) }));
    return 2;
  }
}
