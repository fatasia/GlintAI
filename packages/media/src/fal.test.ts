import { expect, it, vi } from "vitest";
import { FalClient } from "./fal";
const options = { confirmExecute: true as const };
it("submits once, restores by model/id and uses owner/app rather than endpoint or untrusted response URLs", async () => {
  const network = vi.fn(async (url: string, init: RequestInit) => Response.json(init.method === "POST" ? { request_id: "r1", status_url: "https://evil.test/status", response_url: "https://evil.test/result" } : url.endsWith("/status") ? { request_id: "r1", status: "COMPLETED" } : { images: [{ url: "https://cdn.example.test/image.png" }] }));
  const first = new FalClient("fixture", network); expect(await first.submit("owner/app/subpath", { prompt: "x" }, options)).toEqual({ provider: "fal", model: "owner/app/subpath", requestId: "r1" });
  const resumed = new FalClient("fixture", network); const result = await resumed.result("owner/app/subpath", "r1"); expect(result.task.state).toBe("success"); expect(result.output).toHaveProperty("images");
  expect(network.mock.calls.map(([url]) => url)).toEqual(["https://queue.fal.run/owner/app/subpath", "https://queue.fal.run/owner/app/requests/r1/status", "https://queue.fal.run/owner/app/requests/r1"]);
  expect(network.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});
it("requires confirmation and rejects malformed model/id before the network", async () => {
  const network = vi.fn(); const client = new FalClient("fixture", network);
  await expect(client.submit("owner/app", {}, { confirmExecute: false })).rejects.toThrow("confirmation-required");
  await expect(client.status("owner/../escape", "r1")).rejects.toThrow("invalid-model");
  await expect(client.status("owner/app", "../escape")).rejects.toThrow("invalid-id"); expect(network).not.toHaveBeenCalled();
});
it("does not treat failed, pending or unknown status as a usable result", async () => {
  for (const response of [{ status: "COMPLETED", error: "private upstream failure" }, { status: "IN_QUEUE" }, { status: "UNKNOWN" }, { status: "IN_PROGRESS" }]) {
    const network = vi.fn(async () => Response.json({ request_id: "r1", ...response }));
    await expect(new FalClient("fixture", network).result("owner/app", "r1")).rejects.toThrow(); expect(network).toHaveBeenCalledTimes(1);
  }
});
it.each([[200, "OK", "cancelled-queued"], [202, "CANCELLATION_REQUESTED", "requested"], [400, "ALREADY_COMPLETED", "already-completed"], [404, "NOT_FOUND", "not-found"]])("preserves cancel semantics for HTTP %s", async (status, code, expected) => {
  const network = vi.fn(async () => Response.json({ status: code }, { status: Number(status) }));
  expect((await new FalClient("fixture", network).cancel("owner/app/endpoint", "r1")).cancellation).toBe(expected);
  expect(network.mock.calls[0]).toMatchObject(["https://queue.fal.run/owner/app/requests/r1/cancel", { method: "PUT" }]);
});
it("never retries a lost submission", async () => {
  const network = vi.fn(async () => { throw new Error("secret transport body"); });
  await expect(new FalClient("fixture", network).submit("owner/app", {}, options)).rejects.toThrow("transport-or-response-error"); expect(network).toHaveBeenCalledTimes(1);
});

it("requires a successful result response before promoting COMPLETED to success", async () => {
  const client = new FalClient("fixture", async () => Response.json({ request_id: "r1", status: "COMPLETED" }));
  expect((await client.status("owner/app", "r1")).state).toBe("completed");
  for (const failedResult of [() => Response.json({ error: "cancelled" }, { status: 400 }), () => Response.json({ error: "generation failed" })]) {
    const network = vi.fn(async (url: string) => url.endsWith("/status") ? Response.json({ request_id: "r1", status: "COMPLETED" }) : failedResult());
    await expect(new FalClient("fixture", network).result("owner/app", "r1")).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
  }
});
