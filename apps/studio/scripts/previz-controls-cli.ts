import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { exportControlFrame } from "./previz-controls";

async function readDocument(file: string): Promise<unknown> {
  if (!(await fs.lstat(file)).isFile()) throw new Error("input-not-regular-file");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("input-not-regular-file");
    const data = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < data.length) {
      const next = await handle.read(data, size, data.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size === data.length) throw new Error("input-too-large");
    try {
      return JSON.parse(data.subarray(0, size).toString("utf8"));
    } catch {
      throw new Error("invalid-json");
    }
  } finally {
    await handle.close();
  }
}

export async function runPrevizControls(
  args: string[],
  write: (line: string) => void = console.log,
): Promise<number> {
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const flags = new Map<string, string>();
    for (const arg of args) {
      const match = /^--(document|shot|frame|out|width|near|far)=(.+)$/.exec(arg);
      if (!match || flags.has(match[1]!)) throw new Error("invalid-argument");
      flags.set(match[1]!, match[2]!);
    }
    const required = (key: string) => {
      const value = flags.get(key);
      if (!value) throw new Error(`${key}-required`);
      return value;
    };
    const resolve = (file: string) => path.resolve(process.env.INIT_CWD || process.cwd(), file);
    const number = (key: string) => (flags.has(key) ? Number(flags.get(key)) : undefined);
    const input = await readDocument(resolve(required("document")));
    const result = await exportControlFrame(
      input,
      {
        shot: required("shot"),
        frame: Number(required("frame")),
        width: number("width"),
        near: number("near"),
        far: number("far"),
      },
      resolve(required("out")),
      controller.signal,
    );
    write(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch (error) {
    // Filesystem errors include private paths; expose only their stable error code.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "export-failed";
    write(JSON.stringify({ ok: false, error: code }));
    return 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
