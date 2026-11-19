import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";

const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-disabled-"));
process.env.GLINT_DATA_DIR = path.join(isolationRoot, "data");
process.env.GLINT_SESSION_DIR = path.join(isolationRoot, "sessions");
process.env.GLINT_CACHE_DIR = path.join(isolationRoot, "cache");
// Import only after the default server dependencies are confined to this test root.
// @ts-expect-error The server is JavaScript.
const { createWebServer } = await import("./index.mjs");

it("refuses unsafe portable chapter import and export without invoking the media library", async () => {
  const calls: string[] = [];
  const server = createWebServer({ mediaJobs: {
    asset: () => { calls.push("asset"); throw new Error("unexpected asset access"); },
    portableChapterRoot: () => { calls.push("root"); throw new Error("unexpected root access"); },
    install: () => { calls.push("install"); throw new Error("unexpected install"); },
  }, requestLogDir: path.join(isolationRoot, "logs"), composeCacheDir: path.join(isolationRoot, "compose-cache") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const action of ["import", "export", "preview", "commit"]) {
      const response = await fetch(`${base}/api/chapters/${action}-bundle`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapters: [] }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("暂不可用");
    }
    expect(calls).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
