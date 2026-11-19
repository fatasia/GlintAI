import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
// @ts-expect-error Exercise the JavaScript server over HTTP.
import { createWebServer } from "./index.mjs";

it("bounds inputs and serializes configured local upscaling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upscale-http-"));
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const localUpscale = { configured: () => true, run: async (data: Buffer) => { expect(data.toString()).toBe("test"); started(); await waiting; return png; } };
  const server = createWebServer({ localUpscale, requestLogDir: path.join(dir, "logs") });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-upscale`;
    const post = (base64: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64 }) });
    expect(await (await fetch(url)).json()).toEqual({ configured: true });
    expect((await post("%%%" )).status).toBe(400);
    const first = post(Buffer.from("test").toString("base64")); await running;
    expect((await post(Buffer.from("test").toString("base64"))).status).toBe(429);
    release(); const response = await first;
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  } finally {
    release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary directory");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
