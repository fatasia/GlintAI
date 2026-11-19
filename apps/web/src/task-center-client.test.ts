import { afterEach, expect, it, vi } from "vitest";
import {
  canCancel,
  cancelTask,
  parseTaskPage,
  readTasks,
  recoverTask,
  type CenterTask,
} from "./task-center-client";
const task = (family: CenterTask["family"] = "media"): CenterTask => ({
  family,
  id: family === "render" ? "idea-one" : family === "comfyui" ? "comfy-one" : "one",
  state: "running",
  isFinal: false,
  createdAt: null,
  cost: { amount: null, unit: null },
});
afterEach(() => vi.unstubAllGlobals());
it("accepts only bounded typed metadata and rejects duplicates or malformed records", () => {
  expect(
    parseTaskPage({ tasks: [task()], truncated: false, unreadable: 0 }).tasks[0]!.cost.amount,
  ).toBeNull();
  for (const tasks of [
    [task(), task()],
    [{ ...task(), id: "../escape" }],
    [{ ...task(), cost: { amount: -1, unit: null } }],
    Array(101).fill(task()),
    [{ ...task(), state: "invented" }],
  ])
    expect(() => parseTaskPage({ tasks, truncated: false, unreadable: 0 })).toThrow();
});
it("reads the existing-task projection without submissions or automatic status polling", async () => {
  const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ tasks: [task()], truncated: true, unreadable: 1 }),
  );
  vi.stubGlobal("fetch", network);
  expect((await readTasks(new AbortController().signal)).truncated).toBe(true);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0]![0]).toBe("/api/tasks");
});
it.each(["render", "media", "comfyui"] as const)(
  "recovers %s using its existing status protocol",
  async (family) => {
    const row = task(family);
    const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json(
        family === "render"
          ? { id: row.id, status: "done" }
          : {
              taskId: row.id,
              state: "success",
              isFinal: true,
              cost: 3,
              assetUrl: "https://untrusted.invalid/file",
            },
      ),
    );
    vi.stubGlobal("fetch", network);
    const result = await recoverTask(row, new AbortController().signal);
    expect(result.isFinal).toBe(true);
    expect(result.result).toBe(family === "render" ? "/api/video/idea-one" : undefined);
    expect(result.cost.unit).toBeNull();
    expect(network.mock.calls[0]![1].method).toBe("GET");
    expect(network.mock.calls[0]![0]).not.toContain("submit");
  },
);
it("rejects a mismatched status identity and refuses unknown cost units", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ taskId: "another", state: "success", isFinal: true }),
  );
  await expect(recoverTask(task(), new AbortController().signal)).rejects.toThrow("identity");
  expect(() =>
    parseTaskPage({
      tasks: [{ ...task(), cost: { amount: 3, unit: "<bad>" } }],
      truncated: false,
      unreadable: 0,
    }),
  ).toThrow();
});
it.each(["render", "media", "comfyui"] as const)(
  "uses the supported %s cancellation without resubmission",
  async (family) => {
    const row = task(family);
    const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json(
        family === "render"
          ? { cancelled: true }
          : family === "comfyui"
            ? { taskId: row.id, outcome: "not-queued" }
            : { taskId: row.id, state: "cancelled", isFinal: true },
      ),
    );
    vi.stubGlobal("fetch", network);
    expect(await cancelTask(row, new AbortController().signal)).toBe(
      family === "comfyui" ? "notQueued" : "cancelRequested",
    );
    expect(network.mock.calls[0]![1].method).toBe(family === "render" ? "DELETE" : "POST");
    expect(network).toHaveBeenCalledTimes(1);
  },
);
it("does not cancel a terminal task or claim an invalid cancellation receipt succeeded", async () => {
  const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({}),
  );
  vi.stubGlobal("fetch", network);
  expect(canCancel({ ...task(), isFinal: true })).toBe(false);
  await expect(
    cancelTask({ ...task(), isFinal: true }, new AbortController().signal),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  await expect(cancelTask(task(), new AbortController().signal)).rejects.toThrow();
});
it("bounds response bytes and ignores an aborted late reply", async () => {
  vi.stubGlobal("fetch", async () => new Response("x".repeat(1024 * 1024 + 1)));
  await expect(readTasks(new AbortController().signal)).rejects.toThrow("limit");
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => {
    controller.abort();
    return Response.json({ tasks: [], truncated: false, unreadable: 0 });
  });
  await expect(readTasks(controller.signal)).rejects.toThrow();
});
