import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createModelRegistryRoute } from "./model-registry-route.mjs";
let root = "",
  server: Server | undefined;
async function close() {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
}
afterEach(async () => {
  await close();
  if (root) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected cleanup");
    fs.rmSync(root, { recursive: true, force: true });
    root = "";
  }
});
async function start() {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), "registry-http-"));
  const handle = createModelRegistryRoute(
    createModelRegistryStore(path.join(root, "registry.json")),
  );
  const readBody = async (req: IncomingMessage, _signal: unknown, max: number) => {
    expect(_signal).toBeInstanceOf(AbortSignal);
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > max) throw Object.assign(new Error(), { code: "too-large" });
    }
    return text;
  };
  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  server = createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url!, "http://localhost"), { readBody, sendJson }))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/model-registry`;
}
it("saves over real HTTP, restores after server restart and returns bounded conflict errors", async () => {
  let url = await start();
  const before = await (await fetch(url)).json();
  const registry = {
    models: [
      {
        id: "http-model",
        name: "HTTP fixture",
        provider: "fixture",
        kind: "video",
        capabilities: [],
        pricing: { basis: "unknown" },
        adapter: { type: "skills-gateway", model: "provider-id" },
      },
    ],
  };
  const put = () =>
    fetch(url, { method: "PUT", body: JSON.stringify({ registry, baseDigest: before.digest }) });
  const saved = await put();
  expect(saved.status).toBe(200);
  const snapshot = await saved.json();
  await close();
  url = await start();
  expect(await (await fetch(url)).json()).toEqual(snapshot);
  expect((await put()).status).toBe(409);
  const secret = "Bearer fixture-never-return";
  const invalid = await fetch(url, {
    method: "PUT",
    body: JSON.stringify({
      registry: { models: [{ ...registry.models[0], notes: secret }] },
      baseDigest: snapshot.digest,
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain(secret);
  expect(await (await fetch(url)).json()).toEqual(snapshot);
});
it("rejects unrecognized requests, queries and oversized bodies without a record", async () => {
  const url = await start();
  expect((await fetch(url + "?endpoint=ignored")).status).toBe(400);
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(405);
  expect((await fetch(url, { method: "PUT", body: "x".repeat(513 * 1024) })).status).toBe(400);
  expect(fs.existsSync(path.join(root, "registry.json"))).toBe(false);
});
