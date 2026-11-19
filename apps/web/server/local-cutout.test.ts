import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
// @ts-expect-error Exercise the server contract through HTTP.
import { createWebServer } from "./index.mjs";
import { createLocalCutout } from "./local-cutout.mjs";

it("reports unconfigured local paths and rejects unsafe configurations", () => {
  expect(createLocalCutout({ python: "not-absolute", model: "not-absolute" }).configured()).toBe(false);
});

it("cancels only its own spawned process and waits for its close", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }) });
  const run = createLocalCutout({ python: process.execPath, model: process.execPath, spawnImpl: () => child });
  const abort = new AbortController();
  const result = run.run(Buffer.from("input"), abort.signal);
  abort.abort();
  await expect(result).rejects.toThrow();
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("accepts bounded images and serializes local work without exposing paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-cutout-http-"));
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const localCutout = { configured: () => true, run: async (data: Buffer) => { expect(data.toString()).toBe("test"); started(); await waiting; return png; } };
  const server = createWebServer({ localCutout, requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-cutout`;
    expect(await (await fetch(url)).json()).toEqual({ configured: true });
    const post = (base64: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64 }) });
    expect((await post("%%%%")).status).toBe(400);
    const first = post(Buffer.from("test").toString("base64")); await running;
    expect((await post(Buffer.from("test").toString("base64"))).status).toBe(429);
    release(); const response = await first;
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  } finally {
    release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
  }
});
