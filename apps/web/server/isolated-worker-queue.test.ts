import { describe, expect, it, vi } from "vitest";
import { createIsolatedWorkerQueue } from "./isolated-worker-queue.mjs";

function deferred() {
  let resolve!: (value?: any) => void;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("isolated worker admission", () => {
  it("validates limits and rejects work after close", async () => {
    for (const limits of [{ concurrency: 0 }, { concurrency: 1.5 }, { maxQueued: -1 }, { maxQueued: Infinity }]) {
      expect(() => createIsolatedWorkerQueue(limits)).toThrow(RangeError);
    }
    const queue = createIsolatedWorkerQueue();
    await expect(queue.submit(null)).rejects.toThrow(TypeError);
    queue.close(); queue.close();
    await expect(queue.submit(() => {})).rejects.toThrow(/closed/);
  });

  it("enforces independent active and queued limits and FIFO ordering", async () => {
    const isolated = createIsolatedWorkerQueue({ concurrency: 1, maxQueued: 1 });
    const ordinary = createIsolatedWorkerQueue({ concurrency: 1, maxQueued: 0 });
    const gate = deferred();
    const order: string[] = [];
    const first = isolated.submit(async () => { order.push("first"); await gate.promise; return 1; });
    const second = isolated.submit(() => { order.push("second"); return 2; });
    await expect(isolated.submit(() => 3)).rejects.toThrow(/full/);
    expect(isolated.running).toBe(1); expect(isolated.queued).toBe(1);
    await expect(ordinary.submit(() => 4)).resolves.toBe(4);
    expect(order).toEqual(["first"]);
    gate.resolve();
    expect(await first).toBe(1); expect(await second).toBe(2);
    expect(order).toEqual(["first", "second"]);
    await tick(); expect(isolated.running).toBe(0);
  });

  it("cancels queued work without executing it or consuming the next slot", async () => {
    const queue = createIsolatedWorkerQueue({ maxQueued: 1 });
    const gate = deferred();
    const first = queue.submit(() => gate.promise);
    const controller = new AbortController();
    const task = vi.fn();
    const cancelled = queue.submit(task, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.queued).toBe(0);
    const replacement = queue.submit(() => "next");
    gate.resolve(); await first;
    expect(await replacement).toBe("next"); expect(task).not.toHaveBeenCalled();
    await expect(queue.submit(task, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a cancelled running task's slot until its actual cleanup settles", async () => {
    const queue = createIsolatedWorkerQueue({ maxQueued: 1 });
    const gate = deferred();
    const controller = new AbortController();
    let taskSignal: AbortSignal | undefined;
    const first = queue.submit(async signal => { taskSignal = signal; await gate.promise; return "ignored"; }, { signal: controller.signal });
    await tick(); controller.abort();
    expect(taskSignal?.aborted).toBe(true);
    const nextTask = vi.fn(() => "next");
    const next = queue.submit(nextTask);
    await tick(); expect(nextTask).not.toHaveBeenCalled(); expect(queue.running).toBe(1);
    gate.resolve();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await next).toBe("next");
  });

  it("releases slots before notifying callers and skips tasks cancelled before start", async () => {
    const queue = createIsolatedWorkerQueue({ maxQueued: 0 });
    expect(await queue.submit(() => 1)).toBe(1);
    expect(await queue.submit(() => 2)).toBe(2);
    const controller = new AbortController();
    const task = vi.fn();
    const result = queue.submit(task, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(task).not.toHaveBeenCalled();
    expect(await queue.submit(() => 3)).toBe(3);
  });

  it("propagates failures, aborts on close and never starts queued work", async () => {
    const queue = createIsolatedWorkerQueue();
    await expect(queue.submit(() => { throw new Error("worker failed"); })).rejects.toThrow("worker failed");
    await tick();
    const gate = deferred();
    const task = vi.fn();
    const running = queue.submit(async signal => { await gate.promise; expect(signal.aborted).toBe(true); });
    const queued = queue.submit(task);
    await tick(); queue.close();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.running).toBe(1); expect(task).not.toHaveBeenCalled();
    gate.resolve(); await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await tick(); expect(queue.running).toBe(0);
  });
});
