import fs from "node:fs";
import { setImmediate } from "node:timers/promises";

/** A failed copy removes only the destination this call exclusively created. */
export async function publishExclusive(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const output = fs.openSync(destination, "wx");
  let input: number | undefined, complete = false;
  try {
    input = fs.openSync(source, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      for (let offset = 0; offset < count;) {
        signal?.throwIfAborted();
        const written = fs.writeSync(output, buffer, offset, count - offset);
        if (written <= 0) throw new Error("Publication write made no progress");
        offset += written;
      }
      await setImmediate(undefined, { signal });
    }
    signal?.throwIfAborted();
    complete = true;
  } finally {
    try { if (input !== undefined) fs.closeSync(input); }
    catch (error) { complete = false; throw error; }
    finally {
      try { fs.closeSync(output); }
      catch (error) { complete = false; throw error; }
      finally { if (!complete) fs.rmSync(destination, { force: true }); }
    }
  }
}
