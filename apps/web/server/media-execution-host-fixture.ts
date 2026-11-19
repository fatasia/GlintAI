import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createWebServer } from "./index.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { executionFixture } from "./media-execution-fixture";

export const token = "fixture-access-token-at-least-24-characters";
const authorization = `Basic ${Buffer.from(`glint:${token}`).toString("base64")}`;
export async function executionHost(
  f: Awaited<ReturnType<typeof executionFixture>>,
  distDir?: string,
) {
  const server = createWebServer({
    distDir,
    basePath: "/glint/",
    publicHost: "fixture.test",
    accessToken: token,
    authRequired: true,
    mediaJobs: f.jobs,
    mediaSettings: createMediaSettings({ env: {} }),
    modelRegistryStore: f.registry,
    mediaExecutionTransport: f.service.transport,
    mediaExecutionDownload: f.service.download,
    requestLogDir: path.join(f.root, "logs"),
  }) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/glint/api/media/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    server,
    origin,
    request,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
