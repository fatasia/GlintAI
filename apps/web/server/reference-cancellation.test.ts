import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";

it("propagates disconnect and keeps the reference slot occupied until cleanup finishes", async () => {
  let started!: () => void, aborted!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const cleanup = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const server = createWebServer({ referenceBuilder: async ({ signal }: { signal: AbortSignal }) => {
    if (++calls > 1) return { shots: 0 };
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
    await cleanup; throw new Error("cancelled");
  } }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reference/build`;
    const send = (signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ref.mp4", ocr: true }), signal });
    const controller = new AbortController(), first = send(controller.signal).catch(error => error);
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("not started")), 5000))]);
    controller.abort(); expect((await first).name).toBe("AbortError");
    await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("no abort")), 5000))]);
    expect((await send()).status).toBe(409); expect(calls).toBe(1);
    release();
    let status = 409;
    for (let i = 0; i < 50 && status === 409; i++) { await new Promise(resolve => setTimeout(resolve, 20)); status = (await send()).status; }
    expect(status).toBe(200);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
