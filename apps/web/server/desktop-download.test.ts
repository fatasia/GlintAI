import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
// @ts-expect-error The server module is JavaScript.
import { createDesktopDownload } from "./desktop-download.mjs";

it("serves only the explicitly configured ZIP via GET and HEAD", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-download-test-"));
  const archive = path.join(root, "release.zip");
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  fs.writeFileSync(archive, bytes);
  const download = createDesktopDownload({ file: archive });
  const server = http.createServer((req, res) => download.handle(req, res));
  try {
    expect(download.available()).toBe(true);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="Glint-Windows.zip"');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const get = await fetch(url); expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    fs.writeFileSync(archive, "not a zip");
    expect(download.available()).toBe(false);
    expect((await fetch(url)).status).toBe(404);
    expect(createDesktopDownload({ file: "relative.zip" }).available()).toBe(false);
    expect(createDesktopDownload({ file: root }).available()).toBe(false);
    expect(createDesktopDownload({ file: "" }).available()).toBe(false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
