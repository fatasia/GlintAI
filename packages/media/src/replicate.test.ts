import { expect, it, vi } from "vitest";
import { ReplicateClient } from "./replicate";
const options = { confirmExecute: true as const }, version = "a".repeat(64);
it("serializes official and versioned submits once, resumes via canonical prediction URL and never follows returned URLs", async () => {
  const network = vi.fn(async (_url: string, init: RequestInit) => Response.json({ id: "p1", status: init.method === "POST" ? "starting" : "succeeded", output: ["https://cdn.example.test/video.mp4"], urls: { get: "https://evil.test", cancel: "https://evil.test" } }));
  const client = new ReplicateClient("fixture", network);
  expect((await client.submit({ version }, { prompt: "x" }, options)).state).toBe("pending");
  expect((await client.submit({ model: "owner/model" }, {}, options)).predictionId).toBe("p1");
  const resumed = new ReplicateClient("fixture", network); expect((await resumed.result("p1")).output).toEqual(["https://cdn.example.test/video.mp4"]);
  expect(network.mock.calls.map(([url]) => url)).toEqual(["https://api.replicate.com/v1/predictions", "https://api.replicate.com/v1/models/owner/model/predictions", "https://api.replicate.com/v1/predictions/p1"]);
  expect(network.mock.calls[0]![1]).toMatchObject({ headers: { authorization: "Bearer fixture" }, body: JSON.stringify({ version, input: { prompt: "x" } }) });
});
it("reports actual cancel response state instead of promising termination", async () => {
  for (const state of ["processing", "canceled", "succeeded"]) {
    const network = vi.fn(async () => Response.json({ id: "p1", status: state, output: "https://cdn.example.test/x" }));
    const result = await new ReplicateClient("fixture", network).cancel("p1"); expect(result.state).toBe(state === "processing" ? "running" : state === "canceled" ? "cancelled" : "success");
    expect(network.mock.calls[0]).toMatchObject(["https://api.replicate.com/v1/predictions/p1/cancel", { method: "POST" }]);
  }
});
it("fails closed on bad identity, unknown state, upstream failure and non-final output", async () => {
  for (const response of [{ id: "other", status: "succeeded", output: [] }, { id: "p1", status: "unknown" }, { id: "p1", status: "failed", error: "private details" }, { id: "p1", status: "processing", output: [] }, { id: "p1", status: "succeeded", error: "failed really", output: [] }]) {
    const network = vi.fn(async () => Response.json(response)); await expect(new ReplicateClient("fixture", network).result("p1")).rejects.toThrow(); expect(network).toHaveBeenCalledTimes(1);
  }
});
it("requires confirmation and validates model paths before any request", async () => {
  const network = vi.fn(), client = new ReplicateClient("fixture", network);
  await expect(client.submit({ version }, {}, { confirmExecute: false })).rejects.toThrow("confirmation-required");
  await expect(client.submit({ model: "owner/../model" }, {}, options)).rejects.toThrow("invalid-model");
  await expect(client.submit({ version: "bad" }, {}, options)).rejects.toThrow("invalid-version"); expect(network).not.toHaveBeenCalled();
});
