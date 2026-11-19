import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createWebServer } from "./index.mjs";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createLlmSettings } from "./llm-settings.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { registryTemplate } from "../src/model-registry-data";
let root = "",
  server: Server | undefined;
const token = "registry-fixture-access-token-long-enough";
const headers = {
  authorization: `Basic ${Buffer.from(`glint:${token}`).toString("base64")}`,
  "content-type": "application/json",
};
async function close() {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
}
afterEach(async () => {
  await close();
  if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true });
  root = "";
});
async function start() {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), "registry-host-"));
  server = createWebServer({
    publicHost: "fixture.test",
    accessToken: token,
    authRequired: true,
    basePath: "/glint/",
    modelRegistryStore: createModelRegistryStore(path.join(root, "registry.json")),
    llmSettings: createLlmSettings({}),
    mediaSettings: createMediaSettings({ env: {} }),
    requestLogDir: path.join(root, "logs"),
  }) as Server;
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it("inherits actual host auth/base path/origin checks before registry reads and writes", async () => {
  const origin = await start(),
    url = origin + "/glint/api/settings/model-registry";
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(origin + "/api/settings/model-registry", { headers })).status).toBe(404);
  const initial = await fetch(url, { headers });
  expect(initial.status).toBe(200);
  const before = await initial.json();
  expect(before.models).toEqual([]);
  const body = JSON.stringify({
    registry: { models: registryTemplate() },
    baseDigest: before.digest,
  });
  const foreign = await fetch(url, {
    method: "PUT",
    headers: { ...headers, origin: "https://foreign.invalid" },
    body,
  });
  expect(foreign.status).toBe(403);
  expect(fs.existsSync(path.join(root, "registry.json"))).toBe(false);
  const unauthorized = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(unauthorized.status).toBe(401);
  expect(fs.existsSync(path.join(root, "registry.json"))).toBe(false);
  const saved = await fetch(url, { method: "PUT", headers: { ...headers, origin }, body });
  expect(saved.status).toBe(200);
  const snapshot = await saved.json();
  await close();
  const restarted = await start();
  expect(
    await (await fetch(restarted + "/glint/api/settings/model-registry", { headers })).json(),
  ).toEqual(snapshot);
  const bytes = fs.readFileSync(path.join(root, "registry.json"));
  expect(
    (
      await fetch(restarted + "/glint/api/settings/model-registry", {
        method: "PUT",
        headers: { ...headers, origin: "https://foreign.invalid" },
        body,
      })
    ).status,
  ).toBe(403);
  expect(fs.readFileSync(path.join(root, "registry.json"))).toEqual(bytes);
});
