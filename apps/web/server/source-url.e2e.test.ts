import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
// @ts-expect-error JS server exercised through real HTTP.
import { createWebServer } from "./index.mjs";

it.skipIf(process.env.GLINT_SOURCE_URL_E2E !== "1")("extracts a real public HTTPS page while refusing loopback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-source-url-")), old = process.env.GLINT_SOURCE_PUBLIC_DNS;
  process.env.GLINT_SOURCE_PUBLIC_DNS = "1";
  const server = createWebServer({ requestLogDir: path.join(root, "logs"), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/source/preview`;
    const post = (urlValue: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: urlValue }) });
    const response = await post("https://example.com/"); expect(response.status).toBe(200);
    expect((await response.json()).text).toContain("Example Domain");
    expect((await post("https://127.0.0.1/")).status).toBe(400);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (old === undefined) delete process.env.GLINT_SOURCE_PUBLIC_DNS; else process.env.GLINT_SOURCE_PUBLIC_DNS = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);
