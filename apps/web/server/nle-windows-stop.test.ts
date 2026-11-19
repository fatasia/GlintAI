import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
// @ts-expect-error JavaScript server helper.
import { cleanupStoppedRender, stopWindowsRenderTree } from "./nle-windows-stop.mjs";

it("waits for taskkill completion before removing a stopped render", async () => {
  const killer = new EventEmitter(), child = { pid: 123, exitCode: null, kill: vi.fn() }, remove = vi.fn();
  const spawn = vi.fn((_command: string, _args: string[]) => killer), stop = stopWindowsRenderTree(child, spawn);
  const cleanup = cleanupStoppedRender("temporary-output", stop, remove);
  await Promise.resolve(); expect(remove).not.toHaveBeenCalled();
  expect(spawn.mock.calls[0]![1]).toEqual(["/PID", "123", "/T", "/F"]);
  killer.emit("close", 0);
  expect(await cleanup).toBe(true); expect(remove).toHaveBeenCalledWith("temporary-output");
});

it("preserves temporary output and falls back to killing the parent when taskkill fails", async () => {
  const killer = new EventEmitter(), child = { pid: 123, exitCode: null, kill: vi.fn() }, remove = vi.fn();
  const stop = stopWindowsRenderTree(child, () => killer);
  killer.emit("close", 1);
  expect(await cleanupStoppedRender("temporary-output", stop, remove)).toBe(false);
  expect(child.kill).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
});

it("retains output if taskkill cannot start", async () => {
  const child = { pid: 123, exitCode: null, kill: vi.fn() }, remove = vi.fn();
  const stop = stopWindowsRenderTree(child, () => { throw new Error("not found"); });
  expect(await cleanupStoppedRender("temporary-output", stop, remove)).toBe(false);
  expect(child.kill).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
});
