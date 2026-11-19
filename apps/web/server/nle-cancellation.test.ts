import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";

it("signals the NLE renderer when a client cancels an in-flight HTTP request", async () => {
  let started!: () => void, aborted!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const server = createWebServer({ nleVideoRenderer: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener("abort", () => { aborted(); reject(new Error("cancelled")); }, { once: true });
  }) }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nle/render`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ project: { schemaVersion: 1, id: "cancel", title: "Cancel", fps: 20, width: 1920, height: 1080, tracks: [] } }),
    }).catch(error => error);
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("renderer did not start")), 5000))]);
    controller.abort(); expect((await request).name).toBe("AbortError");
    await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("renderer did not receive abort")), 5000))]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
