import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript server exercised through HTTP.
import { createWebServer } from "./index.mjs";

it("offers only the explicitly configured desktop archive over HTTP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-download-route-"));
  const file = path.join(dir, "release.zip"), payload = Buffer.from([80, 75, 3, 4, 1, 2, 3]);
  fs.writeFileSync(file, payload);
  const previous = process.env.GLINT_DESKTOP_DOWNLOAD_FILE;
  process.env.GLINT_DESKTOP_DOWNLOAD_FILE = file;
  const server = createWebServer();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/api/download/client/status`)).json()).toEqual({ available: true });
    const response = await fetch(`${base}/api/download/client`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    fs.unlinkSync(file);
    expect(await (await fetch(`${base}/api/download/client/status`)).json()).toEqual({ available: false });
    expect((await fetch(`${base}/api/download/client`)).status).toBe(404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_DESKTOP_DOWNLOAD_FILE; else process.env.GLINT_DESKTOP_DOWNLOAD_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
